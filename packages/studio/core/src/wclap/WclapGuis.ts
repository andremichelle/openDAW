import {isDefined, Optional, Procedure, Terminable} from "@opendaw/lib-std"
import {WclapBundle} from "@opendaw/studio-adapters"

export type WclapResource = { bytes: Uint8Array<ArrayBuffer>, type: string }

const MIME_TYPES: Record<string, string> = {
    html: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json",
    wasm: "application/wasm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", webp: "image/webp", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", txt: "text/plain"
}

// Open plugin webviews by device uuid: the engine's `wclapSend` lands here and the bundle's files are served
// to the page (a plugin's page addresses its bundle root, `/ui/index.html`, `/cmaj_api/x.js`).
export namespace WclapGuis {
    type Gui = { receiver: Procedure<ArrayBuffer>, bundle: WclapBundle, pageDirectory: string }
    const guis = new Map<string, Gui>()

    export const register = (uuid: string, bundle: WclapBundle, pageDirectory: string,
                             receiver: Procedure<ArrayBuffer>): Terminable => {
        const gui = {receiver, bundle, pageDirectory}
        guis.set(uuid, gui)
        return {terminate: () => {if (guis.get(uuid) === gui) {guis.delete(uuid)}}}
    }

    export const deliver = (uuid: string, bytes: ArrayBuffer): void => guis.get(uuid)?.receiver(bytes)

    // `/x` names a bundle-root file, else a file next to the page (Basics links `cbor.min.js` beside its html)
    export const resolve = (uuid: string, path: string): Optional<WclapResource> => {
        const gui = guis.get(uuid)
        if (!isDefined(gui)) {return undefined}
        const clean = path.split("?")[0].replace(/^\/+/, "")
        const file = gui.bundle.files.find(file => file.path === clean)
            ?? gui.bundle.files.find(file => file.path === `${gui.pageDirectory}${clean}`)
        if (!isDefined(file)) {return undefined}
        const extension = clean.split(".").pop()?.toLowerCase() ?? ""
        return {bytes: file.bytes, type: MIME_TYPES[extension] ?? "application/octet-stream"}
    }
}
