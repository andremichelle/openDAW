import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {WebSocket} from "ws"
import {createRelay} from "../relay.js"

const Origin = "https://opendaw.studio"
const Tools = [{name: "run_script", description: "Runs a script", inputSchema: {type: "object"}}]
const wait = millis => new Promise(resolve => setTimeout(resolve, millis))

// A fake studio: says hello, publishes its tools and answers every call with its name and the code
const connectStudio = (port, {token, name = "studio", origin = Origin, answer = true} = {}) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/studio`, {origin})
    const studio = {socket, token, closed: null, calls: []}
    socket.on("error", reject)
    socket.on("unexpected-response", (_request, response) => reject(new Error(`status ${response.statusCode}`)))
    socket.on("close", code => {studio.closed = code})
    socket.on("open", () => socket.send(JSON.stringify({type: "hello", token})))
    socket.on("message", data => {
        const message = JSON.parse(String(data))
        if (message.type === "token") {
            if (message.token !== undefined) {studio.token = message.token}
            studio.expires = message.expires
            socket.send(JSON.stringify({type: "agent", instructions: `RULES of ${name}`, tools: Tools}))
            resolve(studio)
        } else if (message.kind === "tool") {
            studio.calls.push(message)
            if (answer) {
                socket.send(JSON.stringify({
                    type: "tool-result", id: message.id,
                    text: `${name}:${message.arguments.code}`, isError: message.arguments.code === "bad"
                }))
            }
        }
    })
})

const rpc = async (port, token, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/agent/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token === null ? {} : {"Authorization": `Bearer ${token}`}),
            ...headers
        },
        body: typeof body === "string" ? body : JSON.stringify(body)
    })
    const text = await response.text()
    return {status: response.status, body: text.length > 0 ? JSON.parse(text) : null}
}

const call = (port, token, code, headers) =>
    rpc(port, token, {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "run_script", arguments: {code}}}, headers)

const startRelay = async (options = {}) => {
    const relay = createRelay({host: "127.0.0.1", port: 0, origins: [Origin], ...options})
    const port = await relay.listen()
    return {relay, port}
}

describe("agent relay", () => {
    let relay
    let port
    before(async () => ({relay, port} = await startRelay({callTimeout: 300})))
    after(() => relay.close())

    it("issues a token and forwards calls to its studio", async () => {
        const studio = await connectStudio(port)
        assert.equal(typeof studio.token, "string")
        assert.ok(studio.token.length >= 40)
        await wait(50)
        const init = await rpc(port, studio.token, {jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-06-18"}})
        assert.equal(init.body.result.instructions, "RULES of studio")
        const list = await rpc(port, studio.token, {jsonrpc: "2.0", id: 2, method: "tools/list"})
        assert.deepEqual(list.body.result.tools, Tools)
        const result = await call(port, studio.token, "good")
        assert.deepEqual(result.body.result, {content: [{type: "text", text: "studio:good"}], isError: false})
        const failed = await call(port, studio.token, "bad")
        assert.equal(failed.body.result.isError, true)
        studio.socket.close()
    })

    it("rejects missing and unknown tokens", async () => {
        assert.equal((await call(port, null, "x", {"X-Forwarded-For": "10.0.0.1"})).status, 401)
        assert.equal((await call(port, "made-up-token", "x", {"X-Forwarded-For": "10.0.0.1"})).status, 401)
    })

    it("never reaches another studio", async () => {
        const first = await connectStudio(port, {name: "first"})
        const second = await connectStudio(port, {name: "second"})
        await wait(50)
        assert.notEqual(first.token, second.token)
        assert.equal((await call(port, first.token, "a")).body.result.content[0].text, "first:a")
        assert.equal((await call(port, second.token, "b")).body.result.content[0].text, "second:b")
        assert.deepEqual(first.calls.map(entry => entry.arguments.code), ["a"])
        assert.deepEqual(second.calls.map(entry => entry.arguments.code), ["b"])
        first.socket.close()
        second.socket.close()
    })

    it("lets a second studio with the same token replace the first", async () => {
        const first = await connectStudio(port, {name: "first"})
        const second = await connectStudio(port, {name: "second", token: first.token})
        await wait(50)
        assert.equal(second.token, first.token)
        assert.equal(first.closed, 4000)
        assert.equal((await call(port, first.token, "c")).body.result.content[0].text, "second:c")
        second.socket.close()
    })

    it("answers when the studio is gone, disconnects mid call or stays silent", async () => {
        const studio = await connectStudio(port, {answer: false})
        await wait(50)
        const silent = await call(port, studio.token, "x")
        assert.equal(silent.body.result.content[0].text, "The studio did not answer in time.")
        const pending = call(port, studio.token, "y")
        await wait(50)
        studio.socket.close()
        assert.equal((await pending).body.result.content[0].text, "The studio disconnected.")
        await wait(50)
        const gone = await call(port, studio.token, "z")
        assert.match(gone.body.result.content[0].text, /No studio is connected with this token/)
        const list = await rpc(port, studio.token, {jsonrpc: "2.0", id: 2, method: "tools/list"})
        assert.deepEqual(list.body.result.tools, Tools)
    })

    it("replaces a token on renew and the old one stops working", async () => {
        const studio = await connectStudio(port)
        await wait(50)
        const old = studio.token
        const renewed = new Promise(resolve => studio.socket.on("message", data => {
            const message = JSON.parse(String(data))
            if (message.type === "token") {resolve(message.token)}
        }))
        studio.socket.send(JSON.stringify({type: "renew"}))
        const token = await renewed
        assert.notEqual(token, old)
        assert.equal((await call(port, old, "x", {"X-Forwarded-For": "10.0.0.2"})).status, 401)
        assert.equal((await call(port, token, "y")).body.result.content[0].text, "studio:y")
        studio.socket.close()
    })

    it("refuses studios from other origins and other paths", async () => {
        await assert.rejects(connectStudio(port, {origin: "https://evil.example"}), /403/)
        await assert.rejects(new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/other`, {origin: Origin})
            socket.on("unexpected-response", (_request, response) => reject(new Error(`status ${response.statusCode}`)))
            socket.on("open", resolve)
        }), /403/)
    })

    it("handles notifications, unknown methods, bad bodies and other verbs", async () => {
        const studio = await connectStudio(port)
        await wait(50)
        assert.equal((await rpc(port, studio.token, {jsonrpc: "2.0", method: "notifications/initialized"})).status, 202)
        assert.equal((await rpc(port, studio.token, {jsonrpc: "2.0", id: 3, method: "nope"})).body.error.code, -32601)
        assert.equal((await rpc(port, studio.token, "{not json")).status, 400)
        assert.equal((await rpc(port, studio.token, [])).status, 400)
        assert.equal((await rpc(port, studio.token, "x".repeat(1024 * 1024 + 1))).status, 413)
        const get = await fetch(`http://127.0.0.1:${port}/agent/mcp`, {headers: {"Authorization": `Bearer ${studio.token}`}})
        assert.equal(get.status, 405)
        assert.equal((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status, 404)
        studio.socket.close()
    })
})

describe("agent relay limits", () => {
    it("blocks a client after too many failed attempts, valid tokens included", async () => {
        const {relay, port} = await startRelay({failureLimit: 3})
        const studio = await connectStudio(port)
        await wait(50)
        const attacker = {"X-Forwarded-For": "10.9.9.9"}
        for (let index = 0; index < 3; index++) {
            assert.equal((await call(port, "guess", "x", attacker)).status, 401)
        }
        assert.equal((await call(port, studio.token, "x", attacker)).status, 429)
        assert.equal((await call(port, studio.token, "x", {"X-Forwarded-For": "10.1.1.1"})).status, 200)
        studio.socket.close()
        await relay.close()
    })

    it("expires tokens and gives an expired studio a new one", async () => {
        let time = 1_000_000
        const {relay, port} = await startRelay({now: () => time, tokenTtl: 1000})
        const studio = await connectStudio(port)
        await wait(50)
        assert.equal(studio.expires, 1_001_000)
        time += 1001
        assert.equal((await call(port, studio.token, "x")).status, 401)
        studio.socket.close()
        const again = await connectStudio(port, {token: studio.token})
        assert.notEqual(again.token, studio.token)
        again.socket.close()
        await relay.close()
    })

    it("keeps tokens across restarts and stores only hashes", async () => {
        const tokenFile = join(mkdtempSync(join(tmpdir(), "agent-relay-")), "tokens.json")
        const first = await startRelay({tokenFile})
        const studio = await connectStudio(first.port)
        await wait(50)
        studio.socket.close()
        await first.relay.close()
        assert.ok(!readFileSync(tokenFile, "utf8").includes(studio.token))
        const second = await startRelay({tokenFile})
        const again = await connectStudio(second.port, {token: studio.token})
        assert.equal(again.token, studio.token)
        await wait(50)
        assert.equal((await call(second.port, studio.token, "x")).body.result.content[0].text, "studio:x")
        again.socket.close()
        await second.relay.close()
    })
})
