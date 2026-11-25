import {UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioFileBox} from "@opendaw/studio-boxes"
import {Workers} from "../Workers"
import {ProjectStorage} from "../project/ProjectStorage"
import {TemplateStorage} from "../project/TemplateStorage"
import {PresetStorage} from "../presets/PresetStorage"
import {SampleStorage} from "./SampleStorage"

export namespace SampleGarbage {
    const path = `${SampleStorage.Folder}/garbage.json`

    let queue: Promise<unknown> = Promise.resolve()

    const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
        const result = queue.then(task)
        queue = result.catch(() => undefined)
        return result
    }

    const read = async (): Promise<Array<UUID.String>> => {
        const {status, value} = await Promises.tryCatch(Workers.Opfs.read(path))
        return status === "rejected" ? [] : JSON.parse(new TextDecoder().decode(value))
    }

    const write = (ids: ReadonlyArray<UUID.String>): Promise<void> =>
        Workers.Opfs.write(path, new TextEncoder().encode(JSON.stringify(ids)))

    export const mark = (uuid: UUID.Bytes): Promise<void> => enqueue(async () => {
        const ids = await read()
        const id = UUID.toString(uuid)
        if (ids.includes(id)) {return}
        console.debug(`SampleGarbage.mark ${id}`)
        await write([...ids, id])
    })

    export const unmark = (uuid: UUID.Bytes): Promise<void> => enqueue(async () => {
        const ids = await read()
        const id = UUID.toString(uuid)
        if (!ids.includes(id)) {return}
        console.debug(`SampleGarbage.unmark ${id}`)
        await write(ids.filter(entry => entry !== id))
    })

    export const list = (): Promise<ReadonlyArray<UUID.String>> => enqueue(read)

    export const purge = (inUse: ReadonlyArray<UUID.String> = []): Promise<ReadonlyArray<UUID.String>> =>
        enqueue(async () => {
            const ids = await read()
            if (ids.length === 0) {
                console.debug("SampleGarbage.purge: nothing to delete")
                return []
            }
            const [usedByProjects, usedByTemplates, usedByPresets] = await Promise.all([
                ProjectStorage.listUsedAssets(AudioFileBox),
                TemplateStorage.listUsedAssets(AudioFileBox),
                PresetStorage.listUsedAssets(AudioFileBox)
            ])
            const deleted: Array<UUID.String> = []
            const failed: Array<UUID.String> = []
            for (const id of ids) {
                if (inUse.includes(id) || usedByProjects.has(id) || usedByTemplates.has(id) || usedByPresets.has(id)) {
                    console.debug(`SampleGarbage.purge: kept ${id} (still in use)`)
                    continue
                }
                if (!await SampleStorage.get().exists(UUID.parse(id))) {
                    console.debug(`SampleGarbage.purge: ${id} is already gone`)
                    continue
                }
                const {status, error} = await Promises.tryCatch(SampleStorage.get().deleteItem(UUID.parse(id)))
                if (status === "resolved") {
                    console.debug(`SampleGarbage.purge: deleted ${id}`)
                    deleted.push(id)
                } else {
                    console.warn(`SampleGarbage.purge: could not delete ${id}`, error)
                    failed.push(id)
                }
            }
            await write(failed)
            return deleted
        })
}
