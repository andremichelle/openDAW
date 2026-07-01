// A persistent sample cache for the wasm app, backed by the Origin Private File System (OPFS). Samples fetched
// from the openDAW cloud (sample-fetch.ts) and samples extracted from an imported .odb bundle (bundle.ts) are
// stored here as WAV bytes, keyed by uuid, so a later load hits the cache instead of the network. The on-disk
// layout mirrors the studio's `SampleStorage` (`samples/v2/<uuid>/audio.wav`), so a bundle exported by the full
// openDAW app drops its samples straight into this cache. The engine only needs the audio; peaks / meta (which
// the studio also stores) are ignored here.
import {UUID} from "@opendaw/lib-std"

const FOLDER = "samples/v2"
const AUDIO_FILE = "audio.wav"

// Walk (optionally creating) the nested `samples/v2` directory under the OPFS root.
const rootDirectory = async (create: boolean): Promise<FileSystemDirectoryHandle> => {
    let handle = await navigator.storage.getDirectory()
    for (const part of FOLDER.split("/")) {
        handle = await handle.getDirectoryHandle(part, {create})
    }
    return handle
}

export namespace SampleStorage {
    // The OPFS layout root, exported so callers can reason about paths (matches the studio bundle format).
    export const Folder = FOLDER

    // Whether the sample's audio is already cached.
    export const has = async (uuid: UUID.Bytes): Promise<boolean> => {
        try {
            const root = await rootDirectory(false)
            const sub = await root.getDirectoryHandle(UUID.toString(uuid), {create: false})
            await sub.getFileHandle(AUDIO_FILE, {create: false})
            return true
        } catch (_reason) {
            return false
        }
    }

    // The cached WAV bytes, or null when not cached.
    export const readAudio = async (uuid: UUID.Bytes): Promise<ArrayBuffer | null> => {
        try {
            const root = await rootDirectory(false)
            const sub = await root.getDirectoryHandle(UUID.toString(uuid), {create: false})
            const file = await sub.getFileHandle(AUDIO_FILE, {create: false})
            return (await file.getFile()).arrayBuffer()
        } catch (_reason) {
            return null
        }
    }

    // Store a sample's WAV bytes (overwrites). Used by both the cloud fetch and the bundle importer.
    export const writeAudio = async (uuid: UUID.Bytes, wav: ArrayBuffer): Promise<void> => {
        const root = await rootDirectory(true)
        const sub = await root.getDirectoryHandle(UUID.toString(uuid), {create: true})
        const file = await sub.getFileHandle(AUDIO_FILE, {create: true})
        const writable = await file.createWritable()
        await writable.write(wav)
        await writable.close()
    }

    // The uuids of every cached sample (for a browse / debug view).
    export const list = async (): Promise<ReadonlyArray<string>> => {
        const names: Array<string> = []
        try {
            const root = await rootDirectory(false)
            // OPFS directory handles are async-iterable over [name, handle].
            for await (const [name, handle] of (root as unknown as {entries(): AsyncIterable<[string, FileSystemHandle]>}).entries()) {
                if (handle.kind === "directory") {names.push(name)}
            }
        } catch (_reason) { /* no cache yet */ }
        return names
    }
}
