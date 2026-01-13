import {EmptyExec, Lazy, UUID} from "@moises-ai/lib-std"
import {Soundfont, SoundfontMetaData} from "@moises-ai/studio-adapters"
import {Workers} from "../Workers"
import {Storage} from "../Storage"

export namespace SoundfontStorage {
    export type NewSoundfont = {
        uuid: UUID.Bytes,
        file: ArrayBuffer,
        meta: SoundfontMetaData
    }
}

export class SoundfontStorage extends Storage<Soundfont, SoundfontMetaData, SoundfontStorage.NewSoundfont,
    [ArrayBuffer, SoundfontMetaData]> {
    static readonly Folder = "soundfont"

    @Lazy
    static get(): SoundfontStorage {return new SoundfontStorage()}

    private constructor() {super(SoundfontStorage.Folder)}

    async save({uuid, file, meta}: SoundfontStorage.NewSoundfont): Promise<void> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        console.debug(`save soundfont '${path}'`)
        return Promise.all([
            Workers.Opfs.write(`${path}/soundfont.sf2`, new Uint8Array(file)),
            Workers.Opfs.write(`${path}/meta.json`, new TextEncoder().encode(JSON.stringify(meta)))
        ]).then(EmptyExec)
    }

    async load(uuid: UUID.Bytes): Promise<[ArrayBuffer, SoundfontMetaData]> {
        const path = `${this.folder}/${UUID.toString(uuid)}`
        return Promise.all([
            Workers.Opfs.read(`${path}/soundfont.sf2`)
                .then(bytes => bytes.buffer as ArrayBuffer),
            Workers.Opfs.read(`${path}/meta.json`)
                .then(bytes => JSON.parse(new TextDecoder().decode(bytes)))
        ])
    }
}
