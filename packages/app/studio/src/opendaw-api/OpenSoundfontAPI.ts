import {asDefined, Lazy, Procedure, unitValue, UUID} from "@opendaw/lib-std"
import {Soundfont, SoundfontMetaData} from "@opendaw/studio-adapters"
import {OpenDAWHeaders} from "./OpenDAWHeaders"
import {SoundfontIndex} from "./SoundfontIndex"
import {fetchIndex} from "./IndexFetch"
import {Promises} from "@opendaw/lib-runtime"

export class OpenSoundfontAPI {
    static readonly ApiRoot = "https://api.opendaw.studio/soundfonts"
    static readonly FileRoot = "https://assets.opendaw.studio/soundfonts"
    static readonly IndexFile = `${OpenSoundfontAPI.FileRoot}/index.json`

    @Lazy
    static get(): OpenSoundfontAPI {return new OpenSoundfontAPI()}

    readonly #memoized: () => Promise<SoundfontIndex> = Promises.memoizeAsync(() =>
        fetchIndex(OpenSoundfontAPI.IndexFile, OpenDAWHeaders).then(json => SoundfontIndex.schema.parse(json)))

    private constructor() {}

    async tree(): Promise<SoundfontIndex> {return this.#memoized()}

    async all(): Promise<ReadonlyArray<Soundfont>> {return SoundfontIndex.flatten(await this.#memoized())}

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
