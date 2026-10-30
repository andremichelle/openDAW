import {
    Arrays, asDefined, ByteArrayInput, ByteArrayOutput, Exec, int, isDefined, Nullable, Option, tryCatch, UUID
} from "@opendaw/lib-std"
import {applyUpdateTasks, BoxGraph, optimizeUpdates, Update, Updates, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Sample, ScriptHostProtocol} from "@opendaw/studio-scripting"
import {checkScript, messageOf, runScript} from "./Script"
import {checksumOf, copyBytes, RequestRecord, RequestStatus, Workspace} from "./Workspace"

type RequestFields = Partial<Pick<RequestRecord, "message" | "output" | "undoes" | "updates" | "checksum">>

const CHANGED = "The project changed while the script ran. Run it again."

const encodeUpdates = (updates: ReadonlyArray<Update>): string => {
    const output = ByteArrayOutput.create()
    output.writeInt(updates.length)
    updates.forEach(update => update.write(output))
    return Buffer.from(output.toArrayBuffer()).toString("base64")
}

const decodeUpdates = (text: string): ReadonlyArray<Update> =>
    Updates.decode(new ByteArrayInput(copyBytes(Buffer.from(text, "base64"))))

const transact = (graph: BoxGraph, procedure: Exec) => {
    const updates: Array<Update> = []
    const subscription = graph.subscribeToAllUpdates({onUpdate: update => updates.push(update)})
    graph.beginTransaction()
    const result = tryCatch(() => {
        procedure()
        graph.endTransaction()
        return optimizeUpdates(updates)
    })
    subscription.terminate()
    if (result.status === "failure" && graph.inTransaction()) {graph.abortTransaction()}
    return result
}

class WorkspaceHost implements ScriptHostProtocol {
    readonly #graph: BoxGraph<BoxIO.TypeMap>
    readonly #name: string
    readonly updates: Array<Update>
    readonly info: Array<string>
    readonly problems: Array<string>

    constructor(graph: BoxGraph<BoxIO.TypeMap>, name: string) {
        this.#graph = graph
        this.#name = name
        this.updates = []
        this.info = []
        this.problems = []
    }

    openProject(): void {
        this.problems.push("A script here edits the workspace project: use 'await openDAW.getProject()'. " +
            "Start a new project with 'init' in another directory.")
    }
    applyUpdates(updates: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>, checksum: Int8Array): void {
        if (!Arrays.equals(this.#graph.checksum(), checksum)) {
            this.problems.push(CHANGED)
            return
        }
        const applied = transact(this.#graph, () => applyUpdateTasks(this.#graph, updates))
        if (applied.status === "success") {
            this.updates.push(...applied.value)
        } else {
            this.problems.push(messageOf(applied.error))
        }
    }
    async hasProject(): Promise<boolean> {return true}
    async fetchProject(): Promise<{ buffer: ArrayBuffer, name: string }> {
        return {buffer: ProjectSkeleton.encode(this.#graph) as ArrayBuffer, name: this.#name}
    }
    async showInfo(headline: string, message: string): Promise<void> {this.info.push(`${headline}: ${message}`)}
    addSample(): Promise<Sample> {return Promise.reject(new Error("Samples are not available here yet"))}
    async listSamples(): Promise<ReadonlyArray<Sample>> {return []}
    renderMixdown(): Promise<never> {return Promise.reject(new Error("Rendering is not available here yet"))}
    saveFile(): Promise<void> {return Promise.reject(new Error("Saving files is not available here yet"))}
}

const newRecord = (label: string, status: RequestStatus, fields: RequestFields): RequestRecord => ({
    id: UUID.toString(UUID.generate()).slice(0, 8), label, status, message: null, output: [], undoes: null,
    updates: null, checksum: null, ...fields, time: new Date().toISOString()
})

const saveRecord = (workspace: Workspace, script: Nullable<string>, label: string, status: RequestStatus,
                    fields: RequestFields): RequestRecord => {
    const request = newRecord(label, status, fields)
    workspace.saveRecord(request, script)
    return request
}

export const runRequest = async (workspace: Workspace, script: string, label: string,
                                 timeout: int = 30_000): Promise<RequestRecord> => {
    const save = (status: RequestStatus, fields: RequestFields) => saveRecord(workspace, script, label, status, fields)
    const graph = workspace.loadGraph()
    const diagnostics = checkScript(script)
    if (diagnostics.length > 0) {
        const lines = diagnostics.map(({line, column, message}) => `line ${line}:${column} ${message}`)
        return save("invalid", {message: lines.join("\n")})
    }
    const before = checksumOf(graph)
    const host = new WorkspaceHost(graph, workspace.name)
    const baseFrequency = ProjectSkeleton.findMandatoryBoxes(graph).rootBox.baseFrequency.getValue()
    const result = await runScript(script, host, {sampleRate: 48_000, baseFrequency}, timeout)
    const output = [...result.output, ...host.info]
    if (result.status !== "done") {return save(result.status, {message: result.message, output})}
    if (host.problems.length > 0) {return save("failed", {message: host.problems.join("\n"), output})}
    if (host.updates.length === 0) {
        return save("unchanged", {message: "No changes. A script applies its changes with 'project.openInStudio()'.", output})
    }
    if (checksumOf(workspace.loadGraph()) !== before) {return save("failed", {message: CHANGED, output})}
    const updates = encodeUpdates(host.updates)
    const request = newRecord(label, "applied", {output, updates, checksum: checksumOf(graph)})
    workspace.commit(graph, request, script)
    return request
}

export const undoRequest = (workspace: Workspace): Option<RequestRecord> => workspace.undoTarget().map(target => {
    const label = `Undo ${target.label}`
    const save = (status: RequestStatus, fields: RequestFields) =>
        saveRecord(workspace, null, label, status, {undoes: target.id, ...fields})
    const graph = workspace.loadGraph()
    if (checksumOf(graph) !== target.checksum) {
        return save("failed", {message: "The project changed outside these tools after that request. Undo cannot take it back."})
    }
    const updates = decodeUpdates(asDefined(target.updates))
    const inverse = () => updates.toReversed().forEach(update => update.inverse(graph))
    const inverted = transact(graph, inverse)
    if (inverted.status === "failure") {return save("failed", {message: messageOf(inverted.error)})}
    const request = newRecord(label, "applied", {undoes: target.id})
    workspace.commit(graph, request, null)
    return request
})

export const formatRecord = ({id, label, status, message, output}: RequestRecord): string =>
    [`${label} (${id}): ${status}`, ...isDefined(message) ? [message] : [], ...output].join("\n")
