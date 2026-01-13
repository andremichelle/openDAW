import {asDefined, Lazy, Procedure, RuntimeNotifier, unitValue, UUID} from "@moises-ai/lib-std"
import {Soundfont, SoundfontMetaData} from "@moises-ai/studio-adapters"
import {OpenDAWHeaders} from "../OpenDAWHeaders"
import {network, Promises} from "@moises-ai/lib-runtime"
import {z} from "zod"

export class OpenSoundfontAPI {
    static readonly ApiRoot = "https://api.opendaw.studio/soundfonts"
    static readonly FileRoot = "https://assets.opendaw.studio/soundfonts"

    @Lazy
    static get(): OpenSoundfontAPI {return new OpenSoundfontAPI()}

    readonly #memoized: () => Promise<ReadonlyArray<Soundfont>> = Promises.memoizeAsync(() => network.defaultFetch(`${OpenSoundfontAPI.ApiRoot}/list.json`, OpenDAWHeaders)
        .then(x => x.json())
        .then(x => z.array(Soundfont).parse(x))
        .catch(reason => RuntimeNotifier.info({
            headline: "OpenSoundfont API",
            message: `Could not connect to OpenSoundfont API\nReason: '${reason}'`
        }).then(() => [])))

    private constructor() {}

    async all(): Promise<ReadonlyArray<Soundfont>> {return this.#memoized()}

    async get(uuid: UUID.Bytes): Promise<Soundfont> {
        const uuidAsString = UUID.toString(uuid)
        return this.all().then(list => asDefined(list
            .find(({uuid}) => uuid === uuidAsString), "Could not find Soundfont"))
    }

    async load(uuid: UUID.Bytes, progress: Procedure<unitValue>): Promise<[ArrayBuffer, SoundfontMetaData]> {
        return this.get(uuid).then(async soundfont => {
            const url = `${OpenSoundfontAPI.FileRoot}/${soundfont.uuid}`
            return fetch(url, OpenDAWHeaders)
                .then(response => {
                    let loaded = 0
                    return new Promise<ArrayBuffer>((resolve, reject) => {
                        const reader = asDefined(response.body, "No body in response").getReader()
                        const chunks: Array<Uint8Array> = []
                        const nextChunk = ({done, value}: ReadableStreamReadResult<Uint8Array>) => {
                            if (done) {
                                resolve(new Blob(chunks as Array<BlobPart>).arrayBuffer())
                            } else {
                                chunks.push(value)
                                loaded += value.length
                                progress(loaded / soundfont.size)
                                reader.read().then(nextChunk, reject)
                            }
                        }
                        reader.read().then(nextChunk, reject)
                    })
                })
                .then(buffer => [buffer, soundfont])
        })
    }
}