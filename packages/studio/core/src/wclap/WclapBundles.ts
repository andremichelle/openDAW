import {isDefined, Optional} from "@opendaw/lib-std"
import {WclapBundle, WclapBundleFile} from "@opendaw/studio-adapters"
import {WclapStorage} from "./WclapStorage"

const BLOCK = 512

// A WCLAP bundle is a `.tar.gz` holding `module.wasm` plus GUI files, fetched once per url and kept in memory.
export namespace WclapBundles {
    const cache = new Map<string, Promise<WclapBundle>>()

    export const fetch = (url: string): Promise<WclapBundle> => {
        const cached = cache.get(url)
        if (isDefined(cached)) {return cached}
        const archive: Promise<ArrayBuffer> = WclapStorage.isLocal(url)
            ? WclapStorage.load(url)
            : globalThis.fetch(url).then(response => {
                if (!response.ok) {throw new Error(`${url}: ${response.status}`)}
                return response.arrayBuffer()
            })
        return unpack(url, archive)
    }

    // makes an archive that is not stored yet resolvable under its url, so it can be described before storing
    export const register = (url: string, archive: ArrayBuffer): Promise<WclapBundle> =>
        unpack(url, Promise.resolve(archive))

    const unpack = (url: string, archive: Promise<ArrayBuffer>): Promise<WclapBundle> => {
        const promise = archive
            .then(bytes => new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())
            .then(buffer => ({files: stripRoot(untar(new Uint8Array(buffer)))}))
        promise.catch(() => cache.delete(url))
        cache.set(url, promise)
        return promise
    }

    export const file = (bundle: WclapBundle, path: string): Optional<WclapBundleFile> =>
        bundle.files.find(file => file.path === path)

    // ustar reader: regular files and GNU long names, everything else skipped
    const untar = (bytes: Uint8Array<ArrayBuffer>): Array<WclapBundleFile> => {
        const files: Array<WclapBundleFile> = []
        const text = (offset: number, length: number): string => {
            const end = bytes.indexOf(0, offset)
            return new TextDecoder().decode(bytes.subarray(offset, Math.min(end === -1 ? offset + length : end, offset + length)))
        }
        const state = {offset: 0, longName: ""}
        while (state.offset + BLOCK <= bytes.length && bytes[state.offset] !== 0) {
            const header = state.offset
            const size = parseInt(text(header + 124, 12).trim() || "0", 8)
            if (!Number.isFinite(size) || size < 0) {throw new Error("malformed tar header")}
            const type = String.fromCharCode(bytes[header + 156])
            const prefix = text(header + 345, 155)
            const name = state.longName.length > 0 ? state.longName : (prefix.length > 0 ? `${prefix}/` : "") + text(header, 100)
            const dataStart = header + BLOCK
            state.longName = ""
            if (type === "L") {
                state.longName = text(dataStart, size)
            } else if (type === "0" || type === "\0") {
                files.push({path: name, bytes: bytes.slice(dataStart, dataStart + size)})
            }
            state.offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
        }
        return files
    }

    // Archives wrap the bundle in one top directory (`basics.wclap/module.wasm`), drop it
    const stripRoot = (files: Array<WclapBundleFile>): Array<WclapBundleFile> => {
        const roots = new Set(files.map(({path}) => path.split("/")[0]))
        if (roots.size !== 1 || files.some(({path}) => !path.includes("/"))) {return files}
        return files.map(({path, bytes}) => ({path: path.substring(path.indexOf("/") + 1), bytes}))
    }
}
