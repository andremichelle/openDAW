import {isDefined, Optional, UUID} from "@opendaw/lib-std"
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

    export const store = async (archive: ArrayBuffer): Promise<string> => {
        const url = await urlFor(archive)
        await Workers.Opfs.write(pathOf(idOf(url)), new Uint8Array(archive))
        return url
    }

    export const save = (id: string, archive: ArrayBuffer): Promise<void> =>
        Workers.Opfs.write(pathOf(id), new Uint8Array(archive))

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
