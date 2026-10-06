import {isDefined, Optional, tryCatch, UUID} from "@opendaw/lib-std"
import {Workers} from "../Workers"

// Locally imported bundles live in OPFS `wclap/<sha256>/bundle.tar.gz`, addressed by an `opfs:<sha256>` url
export namespace WclapStorage {
    export const Folder = "wclap"
    export const Scheme = "opfs:"
    export const FileName = "bundle.tar.gz"

    export const isLocal = (url: string): boolean => url.startsWith(Scheme)
    export const idOf = (url: string): string => url.substring(Scheme.length)
    export const urlOf = (id: string): string => `${Scheme}${id}`
    export const pathOf = (id: string): string => `${Folder}/${id}/${FileName}`

    export const urlFor = async (archive: ArrayBuffer): Promise<string> => urlOf(UUID.toString(await UUID.sha256(archive)))

    export const MetaFileName = "meta.json"
    export const TombstonesPath = `${Folder}/tombstones.json`

    // deletion time per id, a bundle stored later than its deletion is alive again
    export type Tombstones = Record<string, number>

    export const store = async (archive: ArrayBuffer): Promise<string> => {
        const url = await urlFor(archive)
        await save(idOf(url), archive)
        return url
    }

    export const save = async (id: string, archive: ArrayBuffer, storedAt: number = Date.now()): Promise<void> => {
        await Workers.Opfs.write(pathOf(id), new Uint8Array(archive))
        await Workers.Opfs.write(`${Folder}/${id}/${MetaFileName}`, new TextEncoder().encode(JSON.stringify({storedAt})))
    }

    export const storedAt = (id: string): Promise<number> => Workers.Opfs.read(`${Folder}/${id}/${MetaFileName}`)
        .then(bytes => {
            const parsed = tryCatch(() => JSON.parse(new TextDecoder().decode(bytes)) as { storedAt?: unknown })
            return parsed.status === "success" && typeof parsed.value.storedAt === "number" ? parsed.value.storedAt : 0
        }, () => 0)

    export const remove = async (id: string): Promise<void> => {
        await Workers.Opfs.delete(`${Folder}/${id}`)
        await writeTombstones(mergeTombstones(await tombstones(), {[id]: Date.now()}))
    }

    // drops the local copy only, for a deletion that happened on another device
    export const discard = (id: string): Promise<void> => Workers.Opfs.delete(`${Folder}/${id}`)

    export const tombstones = (): Promise<Tombstones> => Workers.Opfs.read(TombstonesPath)
        .then(bytes => parseTombstones(new TextDecoder().decode(bytes)), () => ({}))

    export const writeTombstones = (value: Tombstones): Promise<void> =>
        Workers.Opfs.write(TombstonesPath, new TextEncoder().encode(JSON.stringify(value)))

    export const mergeTombstones = (a: Tombstones, b: Tombstones): Tombstones =>
        Object.fromEntries(Array.from(new Set([...Object.keys(a), ...Object.keys(b)]))
            .map(id => [id, Math.max(a[id] ?? 0, b[id] ?? 0)]))

    export const parseTombstones = (text: string): Tombstones => {
        const parsed = tryCatch(() => JSON.parse(text) as unknown)
        if (parsed.status === "failure" || typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {return {}}
        return Object.fromEntries(Object.entries(parsed.value).filter(([, time]) => typeof time === "number"))
    }

    export const exists = (id: string): Promise<boolean> => Workers.Opfs.exists(pathOf(id))

    export type RemoteFetcher = (id: string) => Promise<ArrayBuffer>

    const remote: { fetch: Optional<RemoteFetcher> } = {fetch: undefined}

    // a peer in a live room serves bundles this user does not hold, see ChainedWclapProvider
    export const installRemote = (fetcher: Optional<RemoteFetcher>): void => {remote.fetch = fetcher}

    export const load = async (url: string): Promise<ArrayBuffer> => {
        const id = idOf(url)
        if (await exists(id)) {return loadId(id)}
        if (!isDefined(remote.fetch)) {throw new Error(`WebCLAP bundle ${id} is not stored`)}
        const archive = await remote.fetch(id)
        if (await urlFor(archive) !== url) {throw new Error(`WebCLAP bundle ${id} arrived with a different hash`)}
        await save(id, archive)
        return archive
    }

    export const loadId = (id: string): Promise<ArrayBuffer> => Workers.Opfs.read(pathOf(id))
        .then(bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)

    export const list = (): Promise<ReadonlyArray<string>> => Workers.Opfs.list(Folder)
        .then(entries => entries.filter(entry => entry.kind === "directory").map(entry => entry.name), () => [])
}
