#!/usr/bin/env node
// Serves the stage dir to the Studio for the audition, also to dev.opendaw.studio (CORS and private network access)
import {createServer} from "node:http"
import {readFile} from "node:fs/promises"
import {join, normalize} from "node:path"

const root = process.argv[2]
if (!root) {
    console.error("Usage: node scripts/sampler-library/serve.mjs <stage dir>")
    process.exit(1)
}
createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Private-Network", "true")
    response.setHeader("Access-Control-Allow-Headers", "*")
    if (request.method === "OPTIONS") {
        response.writeHead(204).end()
        return
    }
    const path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname)).replace(/^(\.\.[/\\])+/, "")
    try {
        response.writeHead(200).end(await readFile(join(root, path)))
    } catch {
        response.writeHead(404).end()
    }
}).listen(8090, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:8090`))
