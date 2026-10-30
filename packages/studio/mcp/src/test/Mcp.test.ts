import {PassThrough} from "node:stream"
import {describe, expect, it} from "vitest"
import {serveMcp} from "../Mcp"
import {Workspace} from "../Workspace"
import {temporaryDirectory} from "./Fixture"

type Response = {
    result: { protocolVersion: string, tools: Array<{ name: string }>, content: Array<{ text: string }>, isError: boolean }
    error: { code: number }
}

const exchange = async (messages: ReadonlyArray<unknown>): Promise<ReadonlyArray<Response>> => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines: Array<string> = []
    output.on("data", chunk => lines.push(...String(chunk).split("\n").filter(line => line !== "")))
    const served = serveMcp(new Workspace(temporaryDirectory()), input, output)
    messages.forEach(message => input.write((typeof message === "string" ? message : JSON.stringify(message)) + "\n"))
    input.end()
    await served
    return lines.map(line => JSON.parse(line) as Response)
}

describe("MCP server", () => {
    it("lists the tools and calls one", async () => {
        const [initialize, list, docs, undo] = await exchange([
            {jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2025-06-18"}},
            {jsonrpc: "2.0", method: "notifications/initialized"},
            {jsonrpc: "2.0", id: 2, method: "tools/list"},
            {jsonrpc: "2.0", id: 3, method: "tools/call", params: {name: "docs", arguments: {query: "addInstrumentUnit"}}},
            {jsonrpc: "2.0", id: 4, method: "tools/call", params: {name: "undo", arguments: {}}}
        ])
        expect(initialize.result.protocolVersion).toBe("2025-06-18")
        expect(list.result.tools.map(tool => tool.name)).toEqual(["run", "undo", "docs"])
        expect(docs.result.isError).false
        expect(docs.result.content[0].text).toContain("addInstrumentUnit")
        expect(undo.result).toEqual({content: [{type: "text", text: "Nothing to undo."}], isError: true})
    })

    it("answers messages it cannot use with an error", async () => {
        const [parse, batch, missing] = await exchange([
            "{not json",
            [{jsonrpc: "2.0", id: 1, method: "ping"}],
            {jsonrpc: "2.0", id: 2, method: "tools/call", params: {name: "run", arguments: {}}}
        ])
        expect(parse.error.code).toBe(-32700)
        expect(batch.error.code).toBe(-32600)
        expect(missing.result).toEqual({content: [{type: "text", text: "The argument 'script' must be a string"}], isError: true})
    })
})
