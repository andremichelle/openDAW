import {int, isDefined, Nullable, Optional} from "@opendaw/lib-std"
import {ScriptTokenizer} from "./ScriptTokenizer"

type Token = ScriptTokenizer.Token

const {CONTINUATIONS, REGEX_KEYWORDS, closingParenthesis, isPunct, tokenize} = ScriptTokenizer

const LEADING_CONTINUATIONS: ReadonlyArray<string> = [".", "?", ":", ")", "]", ",", "=", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">"]
const NOT_CALLS: ReadonlyArray<string> = ["function", "if", "for", "while", "switch", "catch", "return", "typeof", "await", "yield"]
const VIEW_DIRECTIVE = /^\/\/ @(?:view|window)\b/m

const continues = (previous: Optional<Token>, token: Token): boolean => {
    if (!isDefined(previous)) {return false}
    if (token.kind === "punct" && LEADING_CONTINUATIONS.includes(token.text)) {return true}
    if (previous.kind === "punct") {return CONTINUATIONS.includes(previous.text)}
    return previous.kind === "word" && REGEX_KEYWORDS.includes(previous.text)
}

const lineOf = (code: string, offset: int): int => {
    let line = 1
    for (let index = 0; index < offset; index++) {
        if (code[index] === "\n") {line++}
    }
    return line
}

const snippet = (code: string, offset: int): string => code.slice(offset).split("\n")[0].trim().slice(0, 24)

const isCall = (tokens: ReadonlyArray<Token>, index: int): boolean => {
    const token = tokens[index]
    if (token.kind === "word" && token.text === "new") {return true}
    if (!isPunct(token, "(")) {return false}
    const previous = tokens[index - 1]
    if (!isDefined(previous)) {return false}
    const callee = (previous.kind === "word" && !NOT_CALLS.includes(previous.text))
        || isPunct(previous, ")") || isPunct(previous, "]")
    if (!callee) {return false}
    const close = closingParenthesis(tokens, index)
    const next = tokens[close + 1]
    return !(isPunct(next, "{") || (isPunct(next, "=") && isPunct(tokens[close + 2], ">")))
}

// Runtime half of the rule, evaluated in both realms after the user code: freezes every top-level value and
// rejects the mutable values freezing cannot reach.
const FREEZE_HELPER = `const __openDAWFreeze = (name, value, viaCall) => {
    const seen = new Set()
    let containsFunction = false
    const walk = target => {
        if (target === null || (typeof target !== "object" && typeof target !== "function") || seen.has(target)) {return}
        if (ArrayBuffer.isView(target) && !(target instanceof DataView)) {
            if (target.length > 0) {throw new Error(\`'\${name}' holds a typed array, which stays mutable. Create it in the constructor.\`)}
            return
        }
        if (target instanceof Map || target instanceof Set || target instanceof WeakMap || target instanceof WeakSet
            || target instanceof Date || target instanceof ArrayBuffer || target instanceof DataView
            || (typeof SharedArrayBuffer !== "undefined" && target instanceof SharedArrayBuffer)) {
            throw new Error(\`'\${name}' holds a \${target.constructor.name}, its contents stay mutable. Create it in the constructor.\`)
        }
        seen.add(target)
        if (typeof target === "function") {containsFunction = true}
        Object.freeze(target)
        for (const key of Reflect.ownKeys(target)) {
            if (typeof target === "function" && key === "prototype") {continue}
            const descriptor = Object.getOwnPropertyDescriptor(target, key)
            if (descriptor !== undefined && Object.hasOwn(descriptor, "value")) {walk(descriptor.value)}
        }
    }
    walk(value)
    if (viaCall && containsFunction) {
        throw new Error(\`'\${name}' is a function created by a call, it can hold hidden state. Declare it as a function or move it into the class.\`)
    }
}`

export namespace ScriptTopLevel {
    export type Declaration = {
        readonly kind: "class" | "function" | "const"
        readonly name: string
        readonly offset: int
        readonly viaCall: boolean
    }

    export type Violation = {
        readonly offset: int
        readonly line: int
        readonly message: string
    }

    export type Result = {
        readonly declarations: ReadonlyArray<Declaration>
        readonly violations: ReadonlyArray<Violation>
    }

    // the rule applies only to scripts that run in a second realm
    export const applies = (code: string): boolean => VIEW_DIRECTIVE.test(code)

    export const check = (code: string): Result => {
        const tokens = tokenize(code)
        const declarations: Array<{ kind: Declaration["kind"], name: string, offset: int, viaCall: boolean }> = []
        const violations: Array<Violation> = []
        const report = (offset: int, message: string): void => {
            violations.push({offset, line: lineOf(code, offset), message})
        }
        let depth = 0
        let expectStart = true
        let kind: Nullable<"class" | "function" | "const" | "other"> = null
        let bodyOpened = false
        // a function body inside a const initializer runs later, its calls do not count (`quiet`): braced bodies
        // end at their closing brace, concise arrow bodies at a comma or closing bracket of their own depth
        const current: {
            constant: Nullable<{ viaCall: boolean }>
            quiet: Nullable<{ depth: int, concise: boolean }>
        } = {constant: null, quiet: null}
        const declare = (declarationKind: Declaration["kind"], name: Token): void => {
            const entry = {kind: declarationKind, name: name.text, offset: name.offset, viaCall: false}
            declarations.push(entry)
            current.constant = declarationKind === "const" ? entry : null
        }
        const classify = (index: int): void => {
            const token = tokens[index]
            const next = tokens[index + 1]
            current.constant = null
            current.quiet = null
            bodyOpened = false
            if (token.kind === "word" && token.text === "class" && next?.kind === "word") {
                kind = "class"
                declare("class", next)
            } else if (token.kind === "word" && (token.text === "function"
                || (token.text === "async" && next?.kind === "word" && next.text === "function"))) {
                kind = "function"
                const name = tokens.slice(index + 1, index + 4).find(candidate => candidate.kind === "word" && candidate.text !== "function")
                if (isDefined(name)) {declare("function", name)}
            } else if (token.kind === "word" && token.text === "const") {
                kind = "const"
                if (next?.kind === "word" && isPunct(tokens[index + 2], "=")) {
                    declare("const", next)
                } else {
                    report(token.offset, "Top-level 'const' must be 'const NAME = ...', no destructuring.")
                }
            } else if (token.kind === "word" && (token.text === "let" || token.text === "var")) {
                kind = "other"
                const name = next?.kind === "word" ? ` ${next.text}` : ""
                report(token.offset, `Top-level '${token.text}${name}' would exist separately in the processor and the view. Move it into the class.`)
            } else if (token.kind === "word" && (token.text === "import" || token.text === "export")) {
                kind = "other"
                report(token.offset, `'${token.text}' is not supported in scripts.`)
            } else if (isPunct(token, ";")) {
                kind = null
                expectStart = true
            } else {
                kind = "other"
                report(token.offset, `Top-level statement '${snippet(code, token.offset)}' is not allowed, only class, function and const.`)
            }
        }
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index]
            if (depth === 0 && (expectStart || (token.lineStart && !continues(tokens[index - 1], token)))) {
                expectStart = false
                classify(index)
                if (isPunct(token, ";")) {continue}
            } else if (depth === 0 && kind === "const" && isPunct(token, ",")
                && tokens[index + 1]?.kind === "word" && isPunct(tokens[index + 2], "=")) {
                declare("const", tokens[index + 1])
            }
            const constant = current.constant
            const quiet = current.quiet
            if (isDefined(constant) && !isDefined(quiet) && isCall(tokens, index)) {constant.viaCall = true}
            if (token.kind !== "punct") {continue}
            if (isDefined(constant) && !isDefined(quiet)) {
                const previous = tokens[index - 1]
                const arrow = isPunct(previous, "=") && token.text === ">"
                if (token.text === "{" && (isPunct(previous, ")") || (isPunct(previous, ">") && isPunct(tokens[index - 2], "=")))) {
                    current.quiet = {depth, concise: false}
                } else if (arrow && !isPunct(tokens[index + 1], "{")) {
                    current.quiet = {depth, concise: true}
                }
            } else if (isDefined(quiet) && quiet.concise && token.text === "," && depth === quiet.depth) {
                current.quiet = null
            }
            if (token.text === "{" && depth === 0 && (kind === "class" || kind === "function") && !bodyOpened) {
                bodyOpened = true
                depth++
                continue
            }
            if (token.text === "{" || token.text === "(" || token.text === "[") {depth++}
            if (token.text === "}" || token.text === ")" || token.text === "]") {
                depth--
                if (isDefined(quiet) && (quiet.concise ? depth < quiet.depth : depth === quiet.depth && token.text === "}")) {
                    current.quiet = null
                }
                if (depth === 0 && token.text === "}" && bodyOpened) {
                    bodyOpened = false
                    kind = null
                    expectStart = true
                }
            }
            if (depth === 0 && token.text === ";") {
                kind = null
                current.constant = null
                current.quiet = null
                expectStart = true
            }
        }
        tokens.forEach((token, index) => {
            const field = tokens[index + 1]
            if (token.kind === "word" && token.text === "static" && field?.kind === "word" && field.text.startsWith("#")
                && !isPunct(tokens[index + 2], "(")) {
                report(token.offset, `'static ${field.text}' is shared state freezing cannot reach. Make it an instance field.`)
            }
        })
        return {declarations, violations}
    }

    export const freezeSource = (declarations: ReadonlyArray<Declaration>): string =>
        [FREEZE_HELPER, ...declarations.map(({name, viaCall}) => `__openDAWFreeze(${JSON.stringify(name)}, ${name}, ${viaCall})`)]
            .join("\n")

    export const format = (violations: ReadonlyArray<Violation>): string =>
        violations.map(({line, message}) => `Line ${line}: ${message}`).join("\n")
}
