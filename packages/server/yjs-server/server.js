#!/usr/bin/env node

import {WebSocketServer} from "ws"
import https from "https"
import http from "http"
import fs from "fs"
import * as number from "lib0/number"
import {setupWSConnection} from "./utils.js"
import * as map from 'lib0/map'

const host = process.env.HOST || "0.0.0.0"
const port = number.parseInt(process.env.PORT || "443")
const isDev = process.env.NODE_ENV === "development"
const disableTls = process.env.DISABLE_TLS === "true"

const requestHandler = (_req, res) => {
    res.writeHead(200, {"Content-Type": "text/plain"})
    res.end("okay")
}

let server
if (disableTls) {
    server = http.createServer(requestHandler)
} else {
    const certConfig = isDev ? {
        key: fs.readFileSync("../../../certs/localhost-key.pem"),
        cert: fs.readFileSync("../../../certs/localhost.pem"),
    } : {
        key: fs.readFileSync("/etc/letsencrypt/live/live.opendaw.studio/privkey.pem"),
        cert: fs.readFileSync("/etc/letsencrypt/live/live.opendaw.studio/fullchain.pem"),
    }
    server = https.createServer(certConfig, requestHandler)
}

// Yjs sync WebSocket server
const wss = new WebSocketServer({noServer: true})
wss.on("connection", setupWSConnection)

// WebRTC signaling server
const signalingWss = new WebSocketServer({noServer: true})

// Track rooms and peers for signaling
const rooms = new Map()

signalingWss.on('connection', (conn, req) => {
    console.log('WebRTC signaling connection from', req.headers.origin)

    const subscribedTopics = new Set()
    let closed = false

    conn.on('message', (data) => {
        if (closed) return

        try {
            const message = JSON.parse(data.toString())
            console.log('Signaling message received:', message.type, message.topics || message.topic)

            switch (message.type) {
                case 'subscribe': {
                    (message.topics || []).forEach(topic => {
                        subscribedTopics.add(topic)
                        const subscribers = map.setIfUndefined(rooms, topic, () => new Set())
                        subscribers.add(conn)
                        console.log(`Peer subscribed to topic: ${topic}, total subscribers: ${subscribers.size}`)
                    })
                    break
                }

                case 'unsubscribe': {
                    (message.topics || []).forEach(topic => {
                        subscribedTopics.delete(topic)
                        const subscribers = rooms.get(topic)
                        if (subscribers) {
                            subscribers.delete(conn)
                            if (subscribers.size === 0) {
                                rooms.delete(topic)
                            }
                        }
                    })
                    break
                }

                case 'publish': {
                    if (message.topic) {
                        const subscribers = rooms.get(message.topic)
                        console.log(`Publishing to topic: ${message.topic}, subscribers: ${subscribers ? subscribers.size : 0}`)
                        if (subscribers) {
                            const forwardMessage = JSON.stringify(message)
                            subscribers.forEach(subscriber => {
                                if (subscriber !== conn) {
                                    try {
                                        subscriber.send(forwardMessage)
                                    } catch (e) {
                                        console.error('Error forwarding message:', e)
                                    }
                                }
                            })
                        }
                    }
                    break
                }

                case 'ping':
                    // Respond to client ping with pong
                    try {
                        conn.send(JSON.stringify({type: 'pong'}))
                    } catch (e) {
                        console.error('Error sending pong:', e)
                    }
                    break
            }
        } catch (err) {
            console.error('Signaling error:', err)
        }
    })

    conn.on('close', () => {
        console.log('Signaling connection closed')
        closed = true
        subscribedTopics.forEach(topic => {
            const subscribers = rooms.get(topic)
            if (subscribers) {
                subscribers.delete(conn)
                if (subscribers.size === 0) {
                    rooms.delete(topic)
                }
            }
        })
    })

    conn.on('error', (err) => {
        console.error('Signaling connection error:', err)
    })
})

server.on("upgrade", (req, socket, head) => {
    const url = req.url || '/'
    console.log("HTTP upgrade request from", req.headers.origin, url)

    // Route to signaling server if path starts with /signaling
    if (url.startsWith('/signaling')) {
        signalingWss.handleUpgrade(req, socket, head, ws => {
            console.log('Signaling upgrade success')
            signalingWss.emit("connection", ws, req)
        })
    } else {
        // All other paths go to Yjs sync (including room names)
        wss.handleUpgrade(req, socket, head, ws => {
            console.log('Yjs sync upgrade success')
            wss.emit("connection", ws, req)
        })
    }
})

const protocol = disableTls ? "ws" : "wss"
server.listen(port, host, () => {
    console.log(`running at '${host}' on port ${port} (${isDev ? 'development' : 'production'}${disableTls ? ', TLS disabled' : ''})`)
    console.log(`- Yjs sync: ${protocol}://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`)
    console.log(`- WebRTC signaling: ${protocol}://${host === '0.0.0.0' ? 'localhost' : host}:${port}/signaling`)
})