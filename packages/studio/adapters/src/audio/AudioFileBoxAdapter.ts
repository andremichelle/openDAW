import {AudioFileBox} from "@opendaw/studio-boxes"
import {int, Option, panic, SortedSet, Terminator, UUID} from "@opendaw/lib-std"
import {Peaks} from "@opendaw/lib-fusion"
import {Address, PointerField} from "@opendaw/lib-box"
import {SampleLoader} from "../sample/SampleLoader"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {BoxAdapter} from "../BoxAdapter"
import {AudioData, AudioInfo, EventCollection} from "@opendaw/lib-dsp"
import {TransientMarkerBoxAdapter} from "./TransientMarkerBoxAdapter"

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

    constructor(context: BoxAdaptersContext, box: AudioFileBox) {
        this.#context = context
        this.#box = box

        this.#transientMarkerAdapters = UUID.newSet(({uuid}) => uuid)
        this.#transients = EventCollection.create(AudioFileBoxAdapter.Comparator)
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
    get info(): Option<AudioInfo> {return SampleLoader.infoOf(this.getOrCreateLoader())}
    get peaks(): Option<Peaks> {return this.getOrCreateLoader().peaks}
    // the frames once the sample is loaded, held by whoever keeps the result
    get audioData(): Promise<AudioData> {return SampleLoader.frames(this.getOrCreateLoader())}

    getOrCreateLoader(): SampleLoader {return this.#context.sampleManager.getOrCreate(this.#box.address.uuid)}

    terminate(): void {this.#terminator.terminate()}
}