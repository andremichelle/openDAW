import {asEnumValue, clamp, Notifier, Observer, SortedSet, Subscription, Terminator, UUID} from "@moises-ai/lib-std"
import {Address, PointerField} from "@moises-ai/lib-box"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {BoxAdapter} from "../BoxAdapter"
import {EventCollection} from "@moises-ai/lib-dsp"
import {WarpMarkerBoxAdapter} from "./WarpMarkerBoxAdapter"
import {AudioTimeStretchBox, WarpMarkerBox} from "@moises-ai/studio-boxes"
import {MarkerComparator} from "./MarkerComparator"
import {TransientPlayMode} from "@moises-ai/studio-enums"

export class AudioTimeStretchBoxAdapter implements BoxAdapter {
    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: AudioTimeStretchBox
    readonly #notifer: Notifier<void>

    readonly #warpMarkerAdapters: SortedSet<UUID.Bytes, WarpMarkerBoxAdapter>
    readonly #warpMarkers: EventCollection<WarpMarkerBoxAdapter>

    constructor(context: BoxAdaptersContext, box: AudioTimeStretchBox) {
        this.#context = context
        this.#box = box

        this.#notifer = new Notifier()
        this.#warpMarkerAdapters = UUID.newSet(({uuid}) => uuid)
        this.#warpMarkers = EventCollection.create(MarkerComparator)
        this.#terminator.ownAll(
            box.warpMarkers.pointerHub.catchupAndSubscribe({
                onAdded: (pointer: PointerField) => {
                    const marker = this.#context.boxAdapters.adapterFor(pointer.box, WarpMarkerBoxAdapter)
                    if (this.#warpMarkerAdapters.add(marker)) {
                        this.#warpMarkers.add(marker)
                        this.#notifer.notify()
                    }
                },
                onRemoved: ({box: {address: {uuid}}}) => {
                    this.#warpMarkers.remove(this.#warpMarkerAdapters.removeByKey(uuid))
                    this.#notifer.notify()
                }
            })
        )
    }

    get box(): AudioTimeStretchBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get warpMarkers(): EventCollection<WarpMarkerBoxAdapter> {return this.#warpMarkers}
    get playbackRate(): number {return this.#box.playbackRate.getValue()}
    get cents(): number {return Math.log2(this.#box.playbackRate.getValue()) * 1200.0}
    set cents(value: number) {this.#box.playbackRate.setValue(clamp(2.0 ** (value / 1200.0), 0.5, 2.0))}
    get transientPlayMode(): TransientPlayMode {
        return asEnumValue(this.#box.transientPlayMode.getValue(), TransientPlayMode)
    }

    clone(): AudioTimeStretchBox {
        const stretchBox = AudioTimeStretchBox.create(this.#box.graph, UUID.generate(), box => {
            box.transientPlayMode.setValue(this.transientPlayMode)
            box.playbackRate.setValue(this.playbackRate)
            box.warpMarkers
        })
        this.warpMarkers.asArray().forEach(marker => WarpMarkerBox.create(stretchBox.graph, UUID.generate(), box => {
            box.position.setValue(marker.position)
            box.seconds.setValue(marker.seconds)
            box.owner.refer(stretchBox.warpMarkers)
        }))
        return stretchBox
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifer.subscribe(observer)}
    onChanged(): void {this.#notifer.notify()}

    terminate(): void {this.#terminator.terminate()}
}