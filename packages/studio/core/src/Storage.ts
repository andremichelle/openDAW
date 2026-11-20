import {Errors, UUID} from "@opendaw/lib-std"
import {Workers} from "./Workers"
import {StructureFile} from "./StructureFile"
import {OpfsQuota} from "./OpfsQuota"
import {TrashList} from "./TrashList"

export abstract class Storage<ITEM extends { uuid: UUID.String } & META, META, NEW, PARTS> {
    readonly structure: StructureFile

    protected constructor(readonly folder: string) {this.structure = new StructureFile(folder)}

    abstract save(item: NEW, cached?: boolean): Promise<void>
    abstract load(uuid: UUID.Bytes): Promise<PARTS>

    async updateMeta(uuid: UUID.Bytes, meta: META): Promise<void> {
        const path = `${this.folder}/${UUID.toString(uuid)}/meta.json`
        const bytes = new TextEncoder().encode(JSON.stringify(meta))
        return OpfsQuota.retry(path, () => Workers.Opfs.write(path, bytes), async () => {})
    }

    protected saveEntry(uuid: UUID.Bytes, files: ReadonlyArray<[string, Uint8Array]>, meta: META,
                        cached: boolean): Promise<void> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
        let began = false
        return OpfsQuota.retry(path, async () => {
            began = !await Workers.Opfs.exists(path)
            for (const [name, bytes] of files) {await Workers.Opfs.write(`${path}/${name}`, bytes)}
            await Workers.Opfs.write(`${path}/meta.json`, metaBytes)
        }, async () => {if (began) {await Workers.Opfs.delete(path)}}, {cached, serial: true})
    }

    async deleteItem(uuid: UUID.Bytes): Promise<void> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        console.debug(`deleteItem '${path}'`)
        return TrashList.deleteRecorded(Workers.Opfs, `${this.folder}/trash.json`, UUID.toString(uuid), path)
    }

    async loadTrashedIds(): Promise<Array<UUID.String>> {return TrashList.read(Workers.Opfs, `${this.folder}/trash.json`)}

    async saveTrashedIds(ids: ReadonlyArray<UUID.String>): Promise<void> {
        return TrashList.write(Workers.Opfs, `${this.folder}/trash.json`, ids)
    }

    async list(): Promise<ReadonlyArray<ITEM>> {
        return Workers.Opfs.list(this.folder)
            .then(async files => {
                const results = await Promise.all(files.filter(file => file.kind === "directory")
                    .map(async ({name}) => {
                        try {
                            const array = await Workers.Opfs.read(`${this.folder}/${name}/meta.json`)
                            return {uuid: name as UUID.String, ...JSON.parse(new TextDecoder().decode(array))}
                        } catch (e) {
                            if (Errors.isTimeout(e)) {throw e}
                            console.warn(`Skipping corrupted entry: ${this.folder}/${name}`, e)
                            return null
                        }
                    }))
                return results.filter((item): item is ITEM => item !== null)
            }, () => [])
    }
}