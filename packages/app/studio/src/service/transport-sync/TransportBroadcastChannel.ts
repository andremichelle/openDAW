import {Procedure, Subscription} from "@opendaw/lib-std"
import {TransportAnchor} from "@/service/transport-sync/TransportAnchor"
import {TransportChannel} from "@/service/transport-sync/TransportChannel"

// Phase 1 prototype channel: BroadcastChannel gives every same-origin tab an in-memory shared
// anchor with zero server/networking code. Superseded by TransportYjsChannel for real live-room
// participants, kept here for same-browser testing without a room.
export class TransportBroadcastChannel implements TransportChannel {
    readonly #channel: BroadcastChannel

    constructor(channelName: string) {this.#channel = new BroadcastChannel(channelName)}

    publish(anchor: TransportAnchor): void {this.#channel.postMessage(anchor)}

    subscribe(observer: Procedure<TransportAnchor>): Subscription {
        const listener = (event: MessageEvent<TransportAnchor>) => observer(event.data)
        this.#channel.addEventListener("message", listener)
        return {terminate: () => this.#channel.removeEventListener("message", listener)}
    }

    terminate(): void {this.#channel.close()}
}
