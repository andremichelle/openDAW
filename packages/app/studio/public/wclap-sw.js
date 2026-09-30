// Serves open WCLAP plugin pages under /wclap/<uuid>/<path>: every request is answered by the studio window
// holding that plugin's bundle in memory (see WclapResources.ts). Scope /wclap/ only.
const PREFIX = /^\/wclap\/([^/]+)\/(.*)$/

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()))

self.addEventListener("fetch", event => {
    const url = new URL(event.request.url)
    if (url.origin !== self.location.origin) {return}
    const match = url.pathname.match(PREFIX)
    if (match === null) {return}
    event.respondWith(serve(match[1], `/${match[2]}${url.search}`))
})

const serve = async (uuid, path) => {
    const clients = await self.clients.matchAll({type: "window", includeUncontrolled: true})
    for (const client of clients) {
        const resource = await ask(client, uuid, path)
        if (resource !== null) {
            return new Response(resource.bytes, {
                headers: {
                    "Content-Type": resource.type,
                    "Cross-Origin-Embedder-Policy": "require-corp",
                    "Cross-Origin-Opener-Policy": "same-origin",
                    "Cross-Origin-Resource-Policy": "same-origin",
                    "Cache-Control": "no-store"
                }
            })
        }
    }
    return new Response(`${path} not found`, {status: 404, headers: {"Content-Type": "text/plain"}})
}

const ask = (client, uuid, path) => new Promise(resolve => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(null), 3000)
    channel.port1.onmessage = ({data}) => {
        clearTimeout(timer)
        resolve(data)
    }
    client.postMessage({type: "wclap-resource", uuid, path}, [channel.port2])
})
