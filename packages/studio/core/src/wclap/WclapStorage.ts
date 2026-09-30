import {UUID} from "@opendaw/lib-std"
import {Workers} from "../Workers"

// Locally imported bundles live in OPFS `wclap/<sha256>/bundle.tar.gz`, addressed by an `opfs:<sha256>` url
export namespace WclapStorage {
    export const Folder = "wclap"
    export const Scheme = "opfs:"

    export const isLocal = (url: string): boolean => url.startsWith(Scheme)

    export const store = async (archive: ArrayBuffer): Promise<string> => {
        const id = UUID.toString(await UUID.sha256(archive))
        await Workers.Opfs.write(`${Folder}/${id}/bundle.tar.gz`, new Uint8Array(archive))
        return `${Scheme}${id}`
    }

    export const load = (url: string): Promise<ArrayBuffer> =>
        Workers.Opfs.read(`${Folder}/${url.substring(Scheme.length)}/bundle.tar.gz`)
            .then(bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}
