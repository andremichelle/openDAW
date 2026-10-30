import {createInterface} from "node:readline"
import {isDefined, tryCatch} from "@opendaw/lib-std"
import {messageOf} from "./Script"
import {TOOLS} from "./Tools"
import {Workspace} from "./Workspace"

type Message = { jsonrpc: "2.0", id?: number | string, method: string, params?: Record<string, unknown> }

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
const INSTRUCTIONS = "Edit an openDAW project with Script API scripts. Read the guide with docs, " +
    "then make one focused change at a time with run and check each result."

const isMessage = (value: unknown): value is Message =>
    typeof value === "object" && isDefined(value) && !Array.isArray(value) && typeof (value as Message).method === "string"

const respond = async (workspace: Workspace, {id, method, params = {}}: Message): Promise<Record<string, unknown>> => {
    switch (method) {
        case "initialize": {
            const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : ""
            const protocolVersion = VERSIONS.includes(requested) ? requested : VERSIONS[0]
            const serverInfo = {name: "opendaw-studio-mcp", version: "0.0.1"}
            return {id, result: {protocolVersion, capabilities: {tools: {}}, serverInfo, instructions: INSTRUCTIONS}}
        }
        case "ping":
            return {id, result: {}}
        case "tools/list":
            return {id, result: {tools: TOOLS.map(({name, description, inputSchema}) => ({name, description, inputSchema}))}}
        case "tools/call": {
            const tool = TOOLS.find(candidate => candidate.name === params.name)
            if (!isDefined(tool)) {return {id, error: {code: -32602, message: `Unknown tool ${String(params.name)}`}}}
            const {text, ok} = await tool.call(workspace, (params.arguments ?? {}) as Record<string, unknown>)
                .catch((error: unknown) => ({text: messageOf(error), ok: false}))
            return {id, result: {content: [{type: "text", text}], isError: !ok}}
        }
        default:
            return {id, error: {code: -32601, message: `Method not found: ${method}`}}
    }
}

export const serveMcp = (workspace: Workspace, input: NodeJS.ReadableStream = process.stdin,
                         output: NodeJS.WritableStream = process.stdout): Promise<void> => {
    const write = (message: Record<string, unknown>): void => {
        output.write(JSON.stringify({jsonrpc: "2.0", ...message}) + "\n")
    }
    const handle = async (line: string): Promise<void> => {
        const parsed = tryCatch(() => JSON.parse(line) as unknown)
        if (parsed.status === "failure") {return write({id: null, error: {code: -32700, message: "Parse error"}})}
        if (!isMessage(parsed.value)) {return write({id: null, error: {code: -32600, message: "Invalid request"}})}
        const message = parsed.value
        if (!isDefined(message.id)) {return}
        write(await respond(workspace, message)
            .catch((error: unknown) => ({id: message.id, error: {code: -32603, message: messageOf(error)}})))
    }
    const lines = createInterface({input})
    let queue = Promise.resolve()
    lines.on("line", line => {if (line.trim() !== "") {queue = queue.then(() => handle(line))}})
    return new Promise(resolve => lines.on("close", () => queue.then(resolve)))
}
