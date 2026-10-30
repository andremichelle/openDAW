import {readFileSync} from "node:fs"
import {createRequire} from "node:module"
import {MessageChannel, Worker} from "node:worker_threads"
import ts from "typescript"
import {asDefined, int, Optional} from "@opendaw/lib-std"
import {Messenger} from "@opendaw/lib-runtime"
import {ScriptConnection, ScriptExecutionContext, ScriptHostProtocol} from "@opendaw/studio-scripting"

export type Diagnostic = { line: int, column: int, message: string }

export type ScriptResult =
    | { status: "done", output: ReadonlyArray<string> }
    | { status: "failed" | "timeout", message: string, output: ReadonlyArray<string> }

export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const readScriptingFile = (name: string): string =>
    readFileSync(createRequire(import.meta.url).resolve(`@opendaw/studio-scripting/${name}`), "utf8")

// The compiler options and declaration files of the studio's script editor (monaco-setup.ts)
const OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, noLib: true, strict: true,
    moduleDetection: ts.ModuleDetectionKind.Force
}
const TOP_LEVEL_RETURN = 1108
const SCRIPT = "/script.ts"
const MAX_OUTPUT_LINES = 1000

let libraries: Optional<ReadonlyMap<string, ts.SourceFile>>

const loadLibraries = (): ReadonlyMap<string, ts.SourceFile> =>
    libraries ??= new Map([["/library.d.ts", "library"], ["/opendaw.d.ts", "api.declaration"]].map(([fileName, name]) =>
        [fileName, ts.createSourceFile(fileName, readScriptingFile(name), ts.ScriptTarget.ES2020)]))

export const checkScript = (script: string): ReadonlyArray<Diagnostic> => {
    const files = loadLibraries()
    const host: ts.CompilerHost = {
        getSourceFile: (fileName, options) =>
            fileName === SCRIPT ? ts.createSourceFile(fileName, script, options, true) : files.get(fileName),
        getDefaultLibFileName: () => "/library.d.ts",
        writeFile: () => {},
        getCurrentDirectory: () => "/",
        getCanonicalFileName: fileName => fileName,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        fileExists: fileName => fileName === SCRIPT || files.has(fileName),
        readFile: fileName => fileName === SCRIPT ? script : files.get(fileName)?.text
    }
    const program = ts.createProgram([SCRIPT, ...files.keys()], OPTIONS, host)
    const source = asDefined(program.getSourceFile(SCRIPT))
    return ts.getPreEmitDiagnostics(program, source)
        .filter(diagnostic => diagnostic.code !== TOP_LEVEL_RETURN)
        .map(diagnostic => {
            const {line, character} = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
            return {line: line + 1, column: character + 1, message}
        })
}

export const runScript = (script: string, host: ScriptHostProtocol, context: ScriptExecutionContext,
                          timeout: int): Promise<ScriptResult> => {
    const code = ts.transpileModule(script, {compilerOptions: OPTIONS}).outputText
    const {port1, port2} = new MessageChannel()
    // The script gets an empty process.env, and its process.stdout is not piped to the stdout of this process
    const worker = new Worker(new URL("../dist/ScriptWorker.js", import.meta.url),
        {workerData: port2, transferList: [port2], env: {}, stdout: true})
    const messenger = Messenger.for(port1)
    const output: Array<string> = []
    let dropped = 0
    messenger.channel("output").subscribe(line => {
        if (output.length < MAX_OUTPUT_LINES) {output.push(line)} else {dropped++}
    })
    const lines = () => dropped === 0 ? output : [...output, `... and ${dropped} more lines`]
    const {promise, resolve} = Promise.withResolvers<ScriptResult>()
    const fail = (status: "failed" | "timeout", message: string) => resolve({status, message, output: lines()})
    const timer = setTimeout(() => fail("timeout", `The script did not finish in ${timeout / 1000} s`), timeout)
    worker.once("error", (error: unknown) => fail("failed", messageOf(error)))
    worker.once("exit", code => fail("failed", `The script stopped its worker (exit code ${code})`))
    ScriptConnection.host(messenger, host).executeScript(code, context)
        .then(() => resolve({status: "done", output: lines()}), (error: unknown) => fail("failed", messageOf(error)))
    return promise.finally(() => {
        clearTimeout(timer)
        messenger.terminate()
        port1.close()
        return worker.terminate()
    })
}
