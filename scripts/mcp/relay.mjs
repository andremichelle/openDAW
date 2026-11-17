// MCP server over stdio for an agent, the studio connects in over a WebSocket and provides tools and texts
import {createInterface} from "node:readline"
import {WebSocketServer} from "ws"

const port = Number(process.env.OPENDAW_MCP_PORT ?? 8790)
const log = message => process.stderr.write(`[opendaw-mcp] ${message}\n`)
const fallbackInstructions = "These tools reach an openDAW studio in the browser. If no tools are listed, ask the user to " +
    "connect the studio: openDAW menu > Connect Agent. Call get_api with part 1 first, it starts with the rules."
const notConnected = "No studio connected. Ask the user to connect the studio: openDAW menu > Connect Agent."
let studio = null
let agent = null
let initialized = false
let nextId = 0
const pending = new Map()
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const toolsChanged = () => {if (initialized) {send({jsonrpc: "2.0", method: "notifications/tools/list_changed"})}}
const server = new WebSocketServer({host: "127.0.0.1", port})
server.on("listening", () => log(`waiting for the studio on ws://127.0.0.1:${port}`))
server.on("connection", socket => {
    if (studio !== null) {
        socket.close(1013, "A studio is already connected")
        return
    }
    studio = socket
    log("studio connected")
    socket.on("message", data => {
        const message = JSON.parse(String(data))
        if (message.type === "agent") {
            agent = {instructions: message.instructions, tools: message.tools}
            toolsChanged()
        } else if (message.type === "tool-result") {
            const resolve = pending.get(message.id)
            pending.delete(message.id)
            resolve?.({text: message.text, isError: message.isError})
        }
    })
    socket.on("close", () => {
        studio = null
        agent = null
        pending.forEach(resolve => resolve({text: "The studio disconnected.", isError: true}))
        pending.clear()
        toolsChanged()
        log("studio disconnected")
    })
})
const callTool = ({name, arguments: args}) => new Promise(resolve => {
    if (studio === null) {
        resolve({text: notConnected, isError: true})
        return
    }
    const id = ++nextId
    pending.set(id, resolve)
    studio.send(JSON.stringify({id, kind: "tool", name, arguments: args ?? {}}))
}).then(({text, isError}) => ({content: [{type: "text", text}], isError}))
const handle = async ({method, params}) => {
    switch (method) {
        case "initialize":
            initialized = true
            return {
                protocolVersion: params.protocolVersion,
                capabilities: {tools: {listChanged: true}},
                serverInfo: {name: "opendaw", version: "0.0.1"},
                instructions: agent?.instructions ?? fallbackInstructions
            }
        case "ping":
            return {}
        case "tools/list":
            return {tools: agent?.tools ?? []}
        case "tools/call":
            return callTool(params)
        default:
            throw {code: -32601, message: `Unknown method ${method}`}
    }
}
createInterface({input: process.stdin}).on("line", line => {
    if (line.trim().length === 0) {return}
    const message = JSON.parse(line)
    if (message.id === undefined) {return}
    Promise.resolve(message).then(handle).then(
        result => send({jsonrpc: "2.0", id: message.id, result}),
        error => send({jsonrpc: "2.0", id: message.id, error: {code: error.code ?? -32603, message: String(error.message ?? error)}}))
})
