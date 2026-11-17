import http from "node:http"
import {WebSocketServer} from "ws"
import {TokenStore} from "./tokens.js"
import {RateLimit} from "./rate-limit.js"

const StudioPath = "/agent/studio"
const McpPath = "/agent/mcp"
const ReplacedCode = 4000
const fallbackInstructions = "These tools reach an openDAW studio in the browser. If no tools are listed or the studio is not " +
    "connected, ask the user to open openDAW and connect the agent: openDAW menu > Connect Agent. " +
    "Call get_api with part 1 first, it starts with the rules."
const notConnected = "The studio is not connected. Ask the user to open openDAW and connect the agent: openDAW menu > Connect Agent."

export const createRelay = ({
                                host = "127.0.0.1", port = 8790, tokenFile = null, origins,
                                tokenTtl = 30 * 24 * 60 * 60 * 1000, callTimeout = 60_000, maxPending = 8,
                                maxBody = 1024 * 1024, helloTimeout = 10_000, now = Date.now,
                                failureLimit = 10, failureWindow = 60_000, blockDuration = 10 * 60_000, log = () => {}
                            }) => {
    const tokens = new TokenStore({file: tokenFile, ttl: tokenTtl, now})
    const limiter = new RateLimit({limit: failureLimit, window: failureWindow, block: blockDuration, now})
    const studios = new Map()
    let nextId = 0
    const clientOf = request => {
        const forwarded = request.headers["x-forwarded-for"]
        const remote = request.socket.remoteAddress
        const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1"
        return local && typeof forwarded === "string" ? forwarded.split(",")[0].trim() : remote
    }
    const closeStudio = (studio, code, reason) => {
        studio.pending.forEach(({resolve, timer}) => {
            clearTimeout(timer)
            resolve({text: "The studio disconnected.", isError: true})
        })
        studio.pending.clear()
        studio.socket.close(code, reason)
    }
    const attach = (socket, hash) => {
        const previous = studios.get(hash)
        if (previous !== undefined) {
            studios.delete(hash)
            closeStudio(previous, ReplacedCode, "Another studio connected with this token")
        }
        const studio = {socket, hash, pending: new Map()}
        studios.set(hash, studio)
        return studio
    }
    const sendToken = (socket, hash, token) =>
        socket.send(JSON.stringify({type: "token", token, expires: tokens.expires(hash)}))
    const wss = new WebSocketServer({noServer: true, maxPayload: 4 * 1024 * 1024})
    wss.on("connection", socket => {
        let studio = null
        const hello = setTimeout(() => socket.close(1008, "No hello"), helloTimeout)
        socket.on("message", data => {
            let message
            try {message = JSON.parse(String(data))} catch {return}
            if (studio === null) {
                if (message.type !== "hello") {return}
                clearTimeout(hello)
                const known = tokens.resolve(message.token)
                if (known !== null) {
                    studio = attach(socket, known)
                    socket.send(JSON.stringify({type: "token", expires: tokens.expires(known)}))
                } else {
                    const {token, hash} = tokens.issue()
                    studio = attach(socket, hash)
                    sendToken(socket, hash, token)
                }
                log("studio connected")
                return
            }
            if (message.type === "agent") {
                tokens.remember(studio.hash, {tools: message.tools, instructions: message.instructions})
            } else if (message.type === "renew") {
                const old = studio.hash
                const {token, hash} = tokens.issue()
                tokens.remember(hash, {tools: tokens.tools(old), instructions: tokens.instructions(old)})
                studios.delete(old)
                tokens.revoke(old)
                studio.hash = hash
                studios.set(hash, studio)
                sendToken(socket, hash, token)
            } else if (message.type === "tool-result") {
                const call = studio.pending.get(message.id)
                if (call === undefined) {return}
                studio.pending.delete(message.id)
                clearTimeout(call.timer)
                call.resolve({text: String(message.text), isError: message.isError === true})
            }
        })
        socket.on("close", () => {
            clearTimeout(hello)
            if (studio === null) {return}
            if (studios.get(studio.hash) === studio) {studios.delete(studio.hash)}
            studio.pending.forEach(({resolve, timer}) => {
                clearTimeout(timer)
                resolve({text: "The studio disconnected.", isError: true})
            })
            studio.pending.clear()
            log("studio disconnected")
        })
    })
    const callStudio = (hash, name, args) => new Promise(resolve => {
        const studio = studios.get(hash)
        if (studio === undefined) {
            resolve({text: notConnected, isError: true})
            return
        }
        if (studio.pending.size >= maxPending) {
            resolve({text: "Too many calls at once, wait for the running ones.", isError: true})
            return
        }
        const id = ++nextId
        const timer = setTimeout(() => {
            studio.pending.delete(id)
            resolve({text: "The studio did not answer in time.", isError: true})
        }, callTimeout)
        studio.pending.set(id, {resolve, timer})
        studio.socket.send(JSON.stringify({id, kind: "tool", name, arguments: args ?? {}}))
    })
    const handleRpc = async (hash, {method, params}) => {
        switch (method) {
            case "initialize":
                return {
                    protocolVersion: params?.protocolVersion ?? "2025-06-18",
                    capabilities: {tools: {}},
                    serverInfo: {name: "opendaw", version: "0.0.1"},
                    instructions: tokens.instructions(hash) ?? fallbackInstructions
                }
            case "ping":
                return {}
            case "tools/list":
                return {tools: tokens.tools(hash)}
            case "tools/call": {
                const {text, isError} = await callStudio(hash, params?.name, params?.arguments)
                return {content: [{type: "text", text}], isError}
            }
            default:
                throw {code: -32601, message: `Unknown method ${method}`}
        }
    }
    const respond = (response, status, body) => {
        response.writeHead(status, {"Content-Type": "application/json"})
        response.end(body === undefined ? "" : JSON.stringify(body))
    }
    const readBody = request => new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        request.on("data", chunk => {
            size += chunk.length
            if (size > maxBody * 4) {
                request.destroy()
                reject(new Error("too large"))
                return
            }
            if (size <= maxBody) {chunks.push(chunk)}
        })
        request.on("end", () => size > maxBody
            ? reject(new Error("too large"))
            : resolve(Buffer.concat(chunks).toString("utf8")))
        request.on("error", reject)
    })
    const handleMcp = async (request, response) => {
        const client = clientOf(request)
        if (limiter.isBlocked(client)) {return respond(response, 429, {error: "Too many failed attempts"})}
        const header = request.headers["authorization"]
        const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : null
        const hash = tokens.resolve(token)
        if (hash === null) {
            limiter.fail(client)
            return respond(response, 401, {error: "Unknown or expired token"})
        }
        if (request.method !== "POST") {
            response.writeHead(405, {"Allow": "POST"})
            return response.end()
        }
        let message
        try {
            message = JSON.parse(await readBody(request))
        } catch (error) {
            return error.message === "too large"
                ? respond(response, 413, {error: "Request too large"})
                : respond(response, 400, {jsonrpc: "2.0", id: null, error: {code: -32700, message: "Parse error"}})
        }
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
            return respond(response, 400, {jsonrpc: "2.0", id: null, error: {code: -32600, message: "Invalid request"}})
        }
        if (message.id === undefined) {return respond(response, 202)}
        try {
            respond(response, 200, {jsonrpc: "2.0", id: message.id, result: await handleRpc(hash, message)})
        } catch (error) {
            respond(response, 200, {jsonrpc: "2.0", id: message.id, error: {code: error.code ?? -32603, message: String(error.message ?? error)}})
        }
    }
    const server = http.createServer((request, response) => {
        const path = (request.url ?? "/").split("?")[0]
        if (path === McpPath) {
            handleMcp(request, response).catch(() => respond(response, 500))
            return
        }
        respond(response, 404, {error: "Not found"})
    })
    server.on("upgrade", (request, socket, head) => {
        const path = (request.url ?? "/").split("?")[0]
        if (path !== StudioPath || !origins.includes(request.headers.origin)) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
            socket.destroy()
            return
        }
        wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request))
    })
    return {
        listen: () => new Promise(resolve => server.listen(port, host, () => resolve(server.address().port))),
        close: () => new Promise(resolve => {
            studios.forEach(studio => closeStudio(studio, 1001, "Server shutdown"))
            studios.clear()
            wss.close()
            server.close(() => resolve())
            server.closeAllConnections()
        })
    }
}
