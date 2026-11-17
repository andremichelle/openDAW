// MCP server over stdio for an agent, the studio connects in over a WebSocket (console-snippet.js)
import {createInterface} from "node:readline"
import {WebSocketServer} from "ws"

const port = Number(process.env.OPENDAW_MCP_PORT ?? 8790)
const partSize = 48_000
const log = message => process.stderr.write(`[opendaw-mcp] ${message}\n`)
const splitAtBlankLines = text => {
    const parts = []
    let rest = text
    while (rest.length > partSize) {
        const cut = rest.lastIndexOf("\n\n", partSize)
        const index = cut > 0 ? cut : partSize
        parts.push(rest.slice(0, index))
        rest = rest.slice(index)
    }
    parts.push(rest)
    return parts
}
let studio = null
let apiParts = []
let nextId = 0
const pending = new Map()
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
        if (message.type === "api") {
            apiParts = message.texts.flatMap(splitAtBlankLines)
            log(`api received, ${apiParts.length} parts`)
        } else if (message.type === "result" || message.type === "context") {
            const resolve = pending.get(message.id)
            pending.delete(message.id)
            resolve?.(message)
        }
    })
    socket.on("close", () => {
        studio = null
        apiParts = []
        pending.forEach(resolve => resolve({error: "The studio disconnected."}))
        pending.clear()
        log("studio disconnected")
    })
})
const notConnected = "No studio connected. Ask the user to connect the agent in the studio (openDAW menu > Connect Agent)."
const requestStudio = request => new Promise(resolve => {
    if (studio === null) {
        resolve({error: notConnected})
        return
    }
    const id = ++nextId
    pending.set(id, resolve)
    studio.send(JSON.stringify({id, ...request}))
})
const tools = [
    {
        name: "get_api",
        description: "Returns one part of the openDAW scripting API (TypeScript declarations). " +
            "Read ALL parts, starting with part 1, before writing the first script. " +
            "The result names the number of parts.",
        inputSchema: {type: "object", properties: {part: {type: "integer", minimum: 1}}, required: ["part"]}
    },
    {
        name: "run_script",
        description: "Runs JavaScript (not TypeScript) in the connected openDAW studio. " +
            "Globals: openDAW (the scripting API), sampleRate, baseFrequency, AudioData, WavFile, midiToHz, PPQN, FFT, " +
            "Chord, Interpolation, dbToGain, gainToDb, ClassicWaveform, VoicingMode, Mixing, TransientPlayMode, " +
            "AudioSendRouting. Top level await and return are allowed. Returns the script's return value (plain data, as JSON), \"ok\" when it returns nothing, or the error message. " +
            "Dialogs wait for a person in the studio, pass values directly instead.",
        inputSchema: {type: "object", properties: {code: {type: "string"}}, required: ["code"]}
    },
    {
        name: "begin_task",
        description: "Tells the studio you start working on a request. The studio shows a dialog with the title, " +
            "elapsed time and number of calls, and collects all changes into one undo step.",
        inputSchema: {type: "object", properties: {title: {type: "string"}}, required: ["title"]}
    },
    {
        name: "end_task",
        description: "Tells the studio you finished the request (or gave up). Closes the dialog.",
        inputSchema: {type: "object", properties: {}}
    },
    {
        name: "get_context",
        description: "Returns what the user focuses in the studio right now: project name, the device being edited " +
            "(editingDevice), the region open in the editor (editingRegion), the selected objects (selection), " +
            "playhead and loop range (in PPQN, a quarter note is 960). Objects come as {type, uuid}, " +
            "resolve them in a script with (await openDAW.getProject()).findByUuid(uuid).",
        inputSchema: {type: "object", properties: {}}
    }
]
const instructions = [
    "You write scripts for the openDAW studio the user has open.",
    "Call begin_task with a short title before your first other openDAW tool call for a request, and end_task when you are done or give up.",
    "If a call answers that the user cancelled, stop working on the request and report what you did so far.",
    "Give every new project a fitting name: openDAW.newProject(\"Moonlight Etude\").",
    "End every script that builds or changes music with project.openInStudio(), the user wants to see and hear the result in the studio.",
    "When the user refers to \"this\", \"the selected\" or \"the open\" device, region or notes, call get_context first and edit the current project (openDAW.getProject()).",
    "Ask the user for approval in the chat before any script calls openDAW.addSample, it adds samples to the user's library."
].join("\n")
const text = (value, isError = false) => ({content: [{type: "text", text: value}], isError})
const callTool = async ({name, arguments: args}) => {
    if (name === "get_api") {
        if (apiParts.length === 0) {return text(notConnected, true)}
        studio.send(JSON.stringify({id: 0, kind: "called"}))
        const part = apiParts[args.part - 1]
        if (part === undefined) {return text(`There are ${apiParts.length} parts.`, true)}
        return text(`Part ${args.part} of ${apiParts.length}\n\n${part}`)
    }
    if (name === "run_script") {
        const {result, error} = await requestStudio({kind: "run", code: args.code})
        if (error !== null && error !== undefined) {return text(error, true)}
        return text(result === null || result === undefined ? "ok" : result)
    }
    if (name === "begin_task" || name === "end_task") {
        const {error} = await requestStudio(name === "begin_task" ? {kind: "begin", title: args.title} : {kind: "end"})
        return error === null || error === undefined ? text("ok") : text(error, true)
    }
    if (name === "get_context") {
        const {error, context} = await requestStudio({kind: "context"})
        return context === undefined ? text(error, true) : text(JSON.stringify(context, null, 2))
    }
    throw {code: -32602, message: `Unknown tool ${name}`}
}
const handle = async ({method, params}) => {
    switch (method) {
        case "initialize":
            return {
                protocolVersion: params.protocolVersion,
                capabilities: {tools: {}},
                serverInfo: {name: "opendaw", version: "0.0.1"},
                instructions

            }
        case "ping":
            return {}
        case "tools/list":
            return {tools}
        case "tools/call":
            return callTool(params)
        default:
            throw {code: -32601, message: `Unknown method ${method}`}
    }
}
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
createInterface({input: process.stdin}).on("line", line => {
    if (line.trim().length === 0) {return}
    const message = JSON.parse(line)
    if (message.id === undefined) {return}
    Promise.resolve(message).then(handle).then(
        result => send({jsonrpc: "2.0", id: message.id, result}),
        error => send({jsonrpc: "2.0", id: message.id, error: {code: error.code ?? -32603, message: String(error.message ?? error)}}))
})
