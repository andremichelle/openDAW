import {isDefined, Nullable, Procedure, Subscription} from "@opendaw/lib-std"
import * as Y from "yjs"
import {TransportAnchor} from "@/service/transport-sync/TransportAnchor"
import {TransportChannel} from "@/service/transport-sync/TransportChannel"

const Field = {Playing: "playing", Epoch: "epoch", AnchorPosition: "anchorPosition", Bpm: "bpm"} as const

const readAnchor = (map: Y.Map<unknown>): Nullable<TransportAnchor> => {
    const playing = map.get(Field.Playing)
    const epoch = map.get(Field.Epoch)
    const anchorPosition = map.get(Field.AnchorPosition)
    const bpm = map.get(Field.Bpm)
    if (typeof playing !== "boolean" || typeof epoch !== "number" || typeof anchorPosition !== "number" || typeof bpm !== "number") {return null}
    return {playing, epoch, anchorPosition, bpm}
}

// Real phase-2 anchor channel: a `transport` Y.Map on the live room's Y.Doc, sibling to the
// `boxes` map used for project sync but never entangled with it, so every room participant
// (not just tabs on the same machine) shares the same anchor.
export class TransportYjsChannel implements TransportChannel {
    readonly #map: Y.Map<unknown>

    constructor(doc: Y.Doc) {this.#map = doc.getMap("transport")}

    publish(anchor: TransportAnchor): void {
        this.#map.doc?.transact(() => {
            this.#map.set(Field.Playing, anchor.playing)
            this.#map.set(Field.Epoch, anchor.epoch)
            this.#map.set(Field.AnchorPosition, anchor.anchorPosition)
            this.#map.set(Field.Bpm, anchor.bpm)
        })
    }

    subscribe(observer: Procedure<TransportAnchor>): Subscription {
        const listener = (event: Y.YMapEvent<unknown>) => {
            if (event.transaction.local) {return}
            const anchor = readAnchor(this.#map)
            if (isDefined(anchor)) {observer(anchor)}
        }
        this.#map.observe(listener)
        return {terminate: () => this.#map.unobserve(listener)}
    }

    terminate(): void {}
}
