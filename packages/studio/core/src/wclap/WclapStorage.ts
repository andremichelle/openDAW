import {UUID} from "@opendaw/lib-std"
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

    export const load = (url: string): Promise<ArrayBuffer> => loadId(idOf(url))

    export const loadId = (id: string): Promise<ArrayBuffer> => Workers.Opfs.read(pathOf(id))
        .then(bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)

    export const list = (): Promise<ReadonlyArray<string>> => Workers.Opfs.list(Folder)
        .then(entries => entries.filter(entry => entry.kind === "directory").map(entry => entry.name), () => [])
}
