import {AudioFileBox} from "@moises-ai/studio-boxes"
import {int, Option, panic, Provider, SortedSet, Terminator, UUID} from "@moises-ai/lib-std"
import {Peaks} from "@moises-ai/lib-fusion"
import {Address, PointerField} from "@moises-ai/lib-box"
import {SampleLoader} from "../sample/SampleLoader"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {BoxAdapter} from "../BoxAdapter"
import {AudioData, EventCollection} from "@moises-ai/lib-dsp"
import {TransientMarkerBoxAdapter} from "./TransientMarkerBoxAdapter"
import {Promises} from "@moises-ai/lib-runtime"

export class AudioFileBoxAdapter implements BoxAdapter {
    static Comparator = (a: TransientMarkerBoxAdapter, b: TransientMarkerBoxAdapter): int => {
        const difference = a.position - b.position
        if (difference === 0) {
            console.warn(a, b)
            return panic("Events at the same position: " + a.position + ", " + b.position)
        }
        return difference
    }

    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: AudioFileBox

    readonly #transientMarkerAdapters: SortedSet<UUID.Bytes, TransientMarkerBoxAdapter>
    readonly #transients: EventCollection<TransientMarkerBoxAdapter>
    readonly #audioDataPromise: Provider<Promise<AudioData>>

    constructor(context: BoxAdaptersContext, box: AudioFileBox) {
        this.#context = context
        this.#box = box

        this.#transientMarkerAdapters = UUID.newSet(({uuid}) => uuid)
        this.#transients = EventCollection.create(AudioFileBoxAdapter.Comparator)
        this.#audioDataPromise = Promises.memoizeAsync(async () => {
            if (this.data.nonEmpty()) {return this.data.unwrap()}
            const {promise, resolve, reject} = Promise.withResolvers<AudioData>()
            const loader = this.getOrCreateLoader()
            const subscription = loader.subscribe(state => {
                if (state.type === "loaded") {
                    queueMicrotask(() => subscription.terminate())
                    resolve(loader.data.unwrap("State mismatch"))
                } else if (state.type === "error") {
                    queueMicrotask(() => subscription.terminate())
                    reject(new Error(state.reason))
                }
            })
            return promise
        })

        this.#terminator.ownAll(
            box.transientMarkers.pointerHub.catchupAndSubscribe({
                onAdded: (pointer: PointerField) => {
                    const marker = this.#context.boxAdapters.adapterFor(pointer.box, TransientMarkerBoxAdapter)
                    if (this.#transientMarkerAdapters.add(marker)) {
                        this.#transients.add(marker)
                    }
                },
                onRemoved: ({box: {address: {uuid}}}) => {
                    this.#transients.remove(this.#transientMarkerAdapters.removeByKey(uuid))
                }
            })
        )
    }

    get box(): AudioFileBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get startInSeconds(): number {return this.#box.startInSeconds.getValue()}
    get endInSeconds(): number {return this.#box.endInSeconds.getValue()}
    get transients(): EventCollection<TransientMarkerBoxAdapter> {return this.#transients}
    get fileName(): string {return this.#box.fileName.getValue()}
    get data(): Option<AudioData> {return this.getOrCreateLoader().data}
    get peaks(): Option<Peaks> {return this.getOrCreateLoader().peaks}
    get audioData(): Promise<AudioData> {return this.#audioDataPromise()}

    getOrCreateLoader(): SampleLoader {return this.#context.sampleManager.getOrCreate(this.#box.address.uuid)}

    terminate(): void {this.#terminator.terminate()}
}