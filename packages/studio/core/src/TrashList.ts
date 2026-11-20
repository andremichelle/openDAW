import {tryCatch, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import type {OpfsProtocol} from "@opendaw/lib-fusion"
import {OpfsQuota} from "./OpfsQuota"

export namespace TrashList {
    export type Files = Pick<OpfsProtocol, "read" | "write" | "delete">

    export const read = async (files: Pick<OpfsProtocol, "read">, path: string): Promise<Array<UUID.String>> => {
        const {status, value} = await Promises.tryCatch(files.read(path))
        if (status === "rejected" || value.byteLength === 0) {return []}
        const parsed = tryCatch(() => JSON.parse(new TextDecoder().decode(value)) as unknown)
        if (parsed.status === "success" && Array.isArray(parsed.value)) {return parsed.value as Array<UUID.String>}
        throw new Error(`'${path}' is damaged, it is left as it is`)
    }

    export const write = (files: Pick<OpfsProtocol, "write">, path: string, ids: ReadonlyArray<UUID.String>): Promise<void> =>
        files.write(path, new TextEncoder().encode(JSON.stringify(ids)))

    export const deleteRecorded = async (files: Files, path: string, id: UUID.String, folder: string): Promise<void> => {
        const ids = await read(files, path)
        if (!ids.includes(id)) {ids.push(id)}
        const recorded = await Promises.tryCatch(write(files, path, ids))
        if (recorded.status === "rejected" && !OpfsQuota.isExceeded(recorded.error)) {throw recorded.error}
        await files.delete(folder)
        if (recorded.status === "rejected") {
            const again = await Promises.tryCatch(write(files, path, ids))
            if (again.status === "rejected") {
                throw new Error(`'${folder}' is deleted, but the storage is too full to note it for the cloud backup`)
            }
        }
    }
}
