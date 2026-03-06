#!/usr/bin/env node

import http from "http"
import fs from "fs"
import path from "path"

const host = process.env.HOST || "0.0.0.0"
const port = parseInt(process.env.PORT || "3000")
const storageDir = process.env.STORAGE_DIR || "/data"

const allowedOrigins = []
if (process.env.ALLOWED_ORIGINS) {
    process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).forEach(o => allowedOrigins.push(o))
}

const checkOrigin = (req) => {
    const origin = req.headers.origin
    if (!origin) return true
    return allowedOrigins.length === 0 || allowedOrigins.includes(origin)
}

const corsHeaders = (req) => {
    const origin = req.headers.origin
    const headers = {
        "Access-Control-Allow-Methods": "GET, PUT, HEAD, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
    }
    if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
        headers["Access-Control-Allow-Origin"] = origin
    }
    return headers
}

const safePath = (requestPath) => {
    const decoded = decodeURIComponent(requestPath)
    const resolved = path.resolve(storageDir, decoded)
    if (!resolved.startsWith(path.resolve(storageDir))) return null
    return resolved
}

const ensureDir = (filePath) => {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true})
    }
}

const collectFiles = (dir, prefix) => {
    const results = []
    if (!fs.existsSync(dir)) return results
    const entries = fs.readdirSync(dir, {withFileTypes: true})
    for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
            results.push(...collectFiles(path.join(dir, entry.name), relative))
        } else {
            results.push(relative)
        }
    }
    return results
}

const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", chunk => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
})

const server = http.createServer(async (req, res) => {
    try {
        const headers = corsHeaders(req)
        for (const [key, value] of Object.entries(headers)) {
            res.setHeader(key, value)
        }
        if (req.method === "OPTIONS") {
            res.writeHead(204)
            res.end()
            return
        }
        if (!checkOrigin(req)) {
            res.writeHead(403, {"Content-Type": "text/plain"})
            res.end("Forbidden")
            return
        }
        const url = new URL(req.url, `http://${req.headers.host}`)
        if (url.pathname === "/health") {
            res.writeHead(200, {"Content-Type": "text/plain"})
            res.end("ok")
            return
        }
        if (!url.pathname.startsWith("/files")) {
            res.writeHead(404, {"Content-Type": "text/plain"})
            res.end("Not Found")
            return
        }
        const filePath = url.pathname.slice("/files".length).replace(/^\//, "")
        if (req.method === "GET" && (!filePath || filePath === "")) {
            const prefix = url.searchParams.get("prefix") || ""
            const searchDir = safePath(prefix)
            if (!searchDir) {
                res.writeHead(400, {"Content-Type": "text/plain"})
                res.end("Invalid path")
                return
            }
            const files = collectFiles(searchDir, prefix || undefined)
            res.writeHead(200, {"Content-Type": "application/json"})
            res.end(JSON.stringify(files))
            return
        }
        const resolved = safePath(filePath)
        if (!resolved) {
            res.writeHead(400, {"Content-Type": "text/plain"})
            res.end("Invalid path")
            return
        }
        switch (req.method) {
            case "PUT": {
                const body = await readBody(req)
                ensureDir(resolved)
                fs.writeFileSync(resolved, body)
                res.writeHead(204)
                res.end()
                break
            }
            case "GET": {
                if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
                    res.writeHead(404, {"Content-Type": "text/plain"})
                    res.end("Not Found")
                    return
                }
                const data = fs.readFileSync(resolved)
                res.writeHead(200, {
                    "Content-Type": "application/octet-stream",
                    "Content-Length": data.length
                })
                res.end(data)
                break
            }
            case "HEAD": {
                if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
                    res.writeHead(200)
                } else {
                    res.writeHead(404)
                }
                res.end()
                break
            }
            case "DELETE": {
                if (fs.existsSync(resolved)) {
                    const stat = fs.statSync(resolved)
                    if (stat.isDirectory()) {
                        fs.rmSync(resolved, {recursive: true})
                    } else {
                        fs.unlinkSync(resolved)
                    }
                }
                res.writeHead(204)
                res.end()
                break
            }
            default: {
                res.writeHead(405, {"Content-Type": "text/plain"})
                res.end("Method Not Allowed")
            }
        }
    } catch (err) {
        console.error("Request error:", req.method, req.url, err)
        if (!res.headersSent) {
            res.writeHead(500, {"Content-Type": "text/plain"})
            res.end("Internal Server Error")
        }
    }
})

server.listen(port, host, () => {
    console.log(`Storage server running at ${host}:${port}, storing files in ${storageDir}`)
})
