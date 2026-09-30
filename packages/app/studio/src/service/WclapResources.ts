import {isDefined} from "@opendaw/lib-std"
import {WclapGuis} from "@opendaw/studio-core"

// Registers /wclap-sw.js (scope /wclap/) once and answers its resource requests from the open plugin bundles
export namespace WclapResources {
    const state: { ready: Promise<void> | undefined } = {ready: undefined}

    export const ensure = (): Promise<void> => {
        if (isDefined(state.ready)) {return state.ready}
        state.ready = navigator.serviceWorker.register("/wclap-sw.js", {scope: "/wclap/"}).then(registration => {
            navigator.serviceWorker.addEventListener("message", onMessage)
            return activated(registration)
        })
        return state.ready
    }

    export const pageUrl = (uuid: string, path: string): string => `/wclap/${uuid}/${path}`

    const activated = (registration: ServiceWorkerRegistration): Promise<void> => new Promise(resolve => {
        const worker = registration.active ?? registration.waiting ?? registration.installing
        if (!isDefined(worker) || worker.state === "activated") {
            resolve()
            return
        }
        worker.addEventListener("statechange", () => {if (worker.state === "activated") {resolve()}})
    })

    const onMessage = (event: MessageEvent): void => {
        const data: unknown = event.data
        const port = event.ports[0]
        if (!isDefined(port) || !isRequest(data)) {return}
        const resource = WclapGuis.resolve(data.uuid, data.path)
        if (isDefined(resource)) {
            const bytes = resource.bytes.slice()
            port.postMessage({bytes, type: resource.type}, [bytes.buffer])
        } else {
            port.postMessage(null)
        }
    }

    type Request = { type: "wclap-resource", uuid: string, path: string }

    const isRequest = (data: unknown): data is Request => {
        if (typeof data !== "object" || !isDefined(data)) {return false}
        const record = data as Partial<Request>
        return record.type === "wclap-resource" && typeof record.uuid === "string" && typeof record.path === "string"
    }
}
