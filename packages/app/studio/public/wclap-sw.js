// serves <base>/wclap/<uuid>/<path> from the host frame holding the bundle (see wclap-frame.html)
const PREFIX = /\/wclap\/([^/]+)\/(.*)$/
const ASK_TIMEOUT_MS = 1000
const hosts = new Set()

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()))
self.addEventListener("message", event => {
    if (event.data?.type === "wclap-host" && event.source) {hosts.add(event.source.id)}
})

self.addEventListener("fetch", event => {
    const url = new URL(event.request.url)
    if (url.origin !== self.location.origin) {return}
    const match = url.pathname.match(PREFIX)
    if (match === null) {return}
    event.respondWith(serve(match[1], `/${match[2]}${url.search}`))
})

const serve = async (uuid, path) => {
    const clients = await self.clients.matchAll({type: "window", includeUncontrolled: true})
    const candidates = clients.filter(client => !new URL(client.url).pathname.match(PREFIX))
    const announced = candidates.filter(client => hosts.has(client.id))
    const resource = await first(announced.length > 0 ? announced : candidates, uuid, path)
    if (resource === null) {
        return new Response(`${path} not found`, {status: 404, headers: {"Content-Type": "text/plain"}})
    }
    return new Response(resource.bytes, {
        headers: {
            "Content-Type": resource.type,
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Cache-Control": "no-store"
        }
    })
}

// every candidate is asked at once, the first one holding the bundle answers
const first = (clients, uuid, path) => new Promise(resolve => {
    if (clients.length === 0) {
        resolve(null)
        return
    }
    let open = clients.length
    for (const client of clients) {
        ask(client, uuid, path).then(resource => {
            if (resource !== null) {resolve(resource)}
            if (--open === 0) {resolve(null)}
        })
    }
})

const ask = (client, uuid, path) => new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS)
    channel.port1.onmessage = ({data}) => {
        clearTimeout(timer)
        resolve(data)
    }
    client.postMessage({type: "wclap-resource", uuid, path}, [channel.port2])
})
