import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import {WebSocket, WebSocketServer} from "ws"
import {createAgentProxy} from "../agent-proxy.js"
import {createRelay} from "../../agent-relay/relay.js"

const Origin = "https://opendaw.studio"
const Tools = [{name: "run_script", description: "Runs a script", inputSchema: {type: "object"}}]

// The front server routes like server.js: /agent/ to the proxy, everything else to the live room handlers
const startFront = async agentPort => {
    const proxy = createAgentProxy({port: agentPort})
    const rooms = new WebSocketServer({noServer: true})
    rooms.on("connection", socket => socket.on("message", data => socket.send(`room:${data}`)))
    const server = http.createServer((req, res) => {
        if (proxy.matches(req)) {
            proxy.handleRequest(req, res)
            return
        }
        res.writeHead(200, {"Content-Type": "text/plain"})
        res.end("okay")
    })
    server.on("upgrade", (req, socket, head) => {
        if (proxy.matches(req)) {
            proxy.handleUpgrade(req, socket, head)
            return
        }
        rooms.handleUpgrade(req, socket, head, ws => rooms.emit("connection", ws, req))
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    return {
        port: server.address().port,
        close: () => new Promise(resolve => {
            rooms.clients.forEach(client => client.terminate())
            server.close(() => resolve())
            server.closeAllConnections()
        })
    }
}

const connectStudio = (port, origin = Origin) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/studio`, {origin})
    socket.on("error", reject)
    socket.on("unexpected-response", (_request, response) => reject(new Error(`status ${response.statusCode}`)))
    socket.on("open", () => socket.send(JSON.stringify({type: "hello"})))
    socket.on("message", data => {
        const message = JSON.parse(String(data))
        if (message.type === "token") {
            socket.send(JSON.stringify({type: "agent", instructions: "RULES", tools: Tools}))
            resolve({socket, token: message.token})
        } else if (message.kind === "tool") {
            socket.send(JSON.stringify({type: "tool-result", id: message.id, text: `ran:${message.arguments.code}`, isError: false}))
        }
    })
})

const call = async (port, token, code, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/agent/mcp`, {
        method: "POST",
        headers: {"Content-Type": "application/json", "Authorization": `Bearer ${token}`, ...headers},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "run_script", arguments: {code}}})
    })
    const text = await response.text()
    return {status: response.status, body: text.length > 0 ? JSON.parse(text) : null}
}

describe("agent proxy in the live room server", () => {
    let relay
    let front
    before(async () => {
        relay = createRelay({host: "127.0.0.1", port: 0, origins: [Origin], failureLimit: 3})
        const agentPort = await relay.listen()
        front = await startFront(agentPort)
    })
    after(async () => {
        await front.close()
        await relay.close()
    })

    it("forwards studio sockets and agent calls", async () => {
        const studio = await connectStudio(front.port)
        await new Promise(resolve => setTimeout(resolve, 50))
        const result = await call(front.port, studio.token, "hello")
        assert.equal(result.status, 200)
        assert.equal(result.body.result.content[0].text, "ran:hello")
        studio.socket.close()
    })

    it("passes refusals of the relay through", async () => {
        await assert.rejects(connectStudio(front.port, "https://evil.example"), /403/)
        assert.equal((await call(front.port, "unknown", "x")).status, 401)
    })

    it("uses the real client address for the rate limit, a sent X-Forwarded-For is ignored", async () => {
        const studio = await connectStudio(front.port)
        await new Promise(resolve => setTimeout(resolve, 50))
        for (let index = 0; index < 3; index++) {
            await call(front.port, "guess", "x", {"X-Forwarded-For": `10.0.0.${index}`})
        }
        assert.equal((await call(front.port, studio.token, "x", {"X-Forwarded-For": "10.9.9.9"})).status, 429)
        studio.socket.close()
    })

    it("leaves live room paths alone", async () => {
        const response = await fetch(`http://127.0.0.1:${front.port}/`)
        assert.equal(await response.text(), "okay")
        const echo = await new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${front.port}/some-room`)
            socket.on("error", reject)
            socket.on("open", () => socket.send("ping"))
            socket.on("message", data => {
                socket.close()
                resolve(String(data))
            })
        })
        assert.equal(echo, "room:ping")
    })
})

describe("agent proxy without a running relay", () => {
    it("answers 503 for calls and sockets", async () => {
        const unused = http.createServer()
        await new Promise(resolve => unused.listen(0, "127.0.0.1", resolve))
        const port = unused.address().port
        await new Promise(resolve => unused.close(resolve))
        const front = await startFront(port)
        assert.equal((await call(front.port, "any", "x")).status, 503)
        await assert.rejects(connectStudio(front.port), /503/)
        await front.close()
    })
})
