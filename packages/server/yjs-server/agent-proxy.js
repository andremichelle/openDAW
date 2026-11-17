import http from "http"

const AgentPrefix = "/agent/"

// Forwards /agent/ to the agent relay (packages/server/agent-relay) on this machine, it runs as its own service
export const createAgentProxy = ({host = "127.0.0.1", port = 8790} = {}) => {
    const headersFor = req => ({...req.headers, "x-forwarded-for": req.socket.remoteAddress ?? ""})
    const unavailable = JSON.stringify({error: "Agent relay unavailable"})
    return {
        matches: req => (req.url ?? "").startsWith(AgentPrefix),
        handleRequest: (req, res) => {
            const upstream = http.request({host, port, method: req.method, path: req.url, headers: headersFor(req)},
                response => {
                    res.writeHead(response.statusCode ?? 502, response.headers)
                    response.pipe(res)
                })
            upstream.on("error", () => {
                if (res.headersSent) {
                    res.destroy()
                    return
                }
                res.writeHead(503, {"Content-Type": "application/json"})
                res.end(unavailable)
            })
            req.pipe(upstream)
        },
        handleUpgrade: (req, socket, head) => {
            const upstream = http.request({host, port, method: req.method, path: req.url, headers: headersFor(req)})
            const refuse = (status, text) => {
                socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
                socket.destroy()
            }
            upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
                const lines = [`HTTP/1.1 101 Switching Protocols`]
                for (let index = 0; index < response.rawHeaders.length; index += 2) {
                    lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
                }
                socket.write(`${lines.join("\r\n")}\r\n\r\n`)
                if (upstreamHead.length > 0) {socket.write(upstreamHead)}
                if (head.length > 0) {upstreamSocket.write(head)}
                upstreamSocket.on("error", () => socket.destroy())
                socket.on("error", () => upstreamSocket.destroy())
                upstreamSocket.pipe(socket).pipe(upstreamSocket)
            })
            upstream.on("response", response => {
                refuse(response.statusCode ?? 502, response.statusMessage ?? "Refused")
                response.resume()
            })
            upstream.on("error", () => refuse(503, "Service Unavailable"))
            upstream.end()
        }
    }
}
