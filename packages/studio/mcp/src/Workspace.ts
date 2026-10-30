import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs"
import {basename, join, resolve} from "node:path"
import {isDefined, Nullable, Option, panic, tryCatch} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"

export type RequestStatus = "applied" | "unchanged" | "invalid" | "failed" | "timeout"

// updates: the recorded edits that undo inverts (base64); checksum: the project after an applied script
export type RequestRecord = {
    id: string
    label: string
    status: RequestStatus
    message: Nullable<string>
    output: ReadonlyArray<string>
    undoes: Nullable<string>
    updates: Nullable<string>
    checksum: Nullable<string>
    time: string
}

export const copyBytes = (bytes: Uint8Array): ArrayBuffer =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

export const checksumOf = (graph: BoxGraph): string => Buffer.from(graph.checksum()).toString("hex")

export class Workspace {
    readonly directory: string

    constructor(directory: string) {this.directory = resolve(directory)}

    get name(): string {return basename(this.directory)}
    get projectFile(): string {return join(this.directory, "project.od")}
    get requestsDirectory(): string {return join(this.directory, "requests")}

    create(project: ArrayBuffer): void {
        if (existsSync(this.projectFile)) {return panic(`${this.directory} already holds a project`)}
        mkdirSync(this.directory, {recursive: true})
        this.#write(this.projectFile, new Uint8Array(project))
    }

    loadGraph(): BoxGraph<BoxIO.TypeMap> {
        if (!existsSync(this.projectFile)) {return panic(`No project in ${this.directory}. Run 'init' first.`)}
        return ProjectSkeleton.decode(copyBytes(readFileSync(this.projectFile))).boxGraph
    }

    saveGraph(graph: BoxGraph): void {this.#write(this.projectFile, new Uint8Array(ProjectSkeleton.encode(graph)))}

    saveRecord(record: RequestRecord, script: Nullable<string>): string {
        mkdirSync(this.requestsDirectory, {recursive: true})
        const number = this.#recordFiles().length + 1
        const stem = join(this.requestsDirectory, `${String(number).padStart(4, "0")}-${record.id}`)
        if (isDefined(script)) {this.#write(`${stem}.ts`, script)}
        this.#write(`${stem}.json`, JSON.stringify(record, null, 2) + "\n")
        return stem
    }

    commit(graph: BoxGraph, record: RequestRecord, script: Nullable<string>): void {
        const stem = this.saveRecord(record, script)
        const saved = tryCatch(() => this.saveGraph(graph))
        if (saved.status === "failure") {
            rmSync(`${stem}.json`, {force: true})
            rmSync(`${stem}.ts`, {force: true})
            throw saved.error
        }
    }

    // The newest applied request that no applied undo took back
    undoTarget(): Option<RequestRecord> {
        const stack: Array<RequestRecord> = []
        this.#recordFiles()
            .map(name => JSON.parse(readFileSync(join(this.requestsDirectory, name), "utf8")) as RequestRecord)
            .filter(record => record.status === "applied")
            .forEach(record => isDefined(record.undoes) ? stack.pop() : stack.push(record))
        return Option.wrap(stack.at(-1))
    }

    #recordFiles(): ReadonlyArray<string> {
        if (!existsSync(this.requestsDirectory)) {return []}
        return readdirSync(this.requestsDirectory).filter(name => name.endsWith(".json"))
            .toSorted((left, right) => parseInt(left) - parseInt(right))
    }

    #write(path: string, data: Uint8Array | string): void {
        const temporary = `${path}.${process.pid}`
        writeFileSync(temporary, data)
        renameSync(temporary, path)
    }
}
