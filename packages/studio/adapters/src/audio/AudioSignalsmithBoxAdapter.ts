import {Notifier, Observer, SortedSet, Subscription, Terminator, UUID} from "@opendaw/lib-std"
import {Address, PointerField} from "@opendaw/lib-box"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {BoxAdapter} from "../BoxAdapter"
import {EventCollection} from "@opendaw/lib-dsp"
import {WarpMarkerBoxAdapter} from "./WarpMarkerBoxAdapter"
import {AudioSignalsmithBox, WarpMarkerBox} from "@opendaw/studio-boxes"
import {MarkerComparator} from "./MarkerComparator"

export class AudioSignalsmithBoxAdapter implements BoxAdapter {
    readonly #terminator = new Terminator()

    readonly #context: BoxAdaptersContext
    readonly #box: AudioSignalsmithBox
    readonly #notifer: Notifier<void>

    readonly #warpMarkerAdapters: SortedSet<UUID.Bytes, WarpMarkerBoxAdapter>
    readonly #warpMarkers: EventCollection<WarpMarkerBoxAdapter>

    constructor(context: BoxAdaptersContext, box: AudioSignalsmithBox) {
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

    get box(): AudioSignalsmithBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get warpMarkers(): EventCollection<WarpMarkerBoxAdapter> {return this.#warpMarkers}

    get transpose(): number {return this.#box.transpose.getValue()}
    set transpose(value: number) {this.#box.transpose.setValue(value)}

    clone(): AudioSignalsmithBox {
        const signalsmithBox = AudioSignalsmithBox.create(this.#box.graph, UUID.generate())
        signalsmithBox.transpose.setValue(this.#box.transpose.getValue())
        this.warpMarkers.asArray().forEach(marker => WarpMarkerBox.create(signalsmithBox.graph, UUID.generate(), box => {
            box.position.setValue(marker.position)
            box.seconds.setValue(marker.seconds)
            box.owner.refer(signalsmithBox.warpMarkers)
        }))
        return signalsmithBox
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifer.subscribe(observer)}
    onChanged(): void {this.#notifer.notify()}

    terminate(): void {this.#terminator.terminate()}
}
