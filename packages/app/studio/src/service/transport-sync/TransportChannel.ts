import {Procedure, Subscription, Terminable} from "@opendaw/lib-std"
import {TransportAnchor} from "@/service/transport-sync/TransportAnchor"

// Implemented by whatever carries the shared anchor: BroadcastChannel for the phase 1
// same-browser prototype, a Yjs `transport` Y.Map for real live-room participants.
export interface TransportChannel extends Terminable {
    publish(anchor: TransportAnchor): void
    subscribe(observer: Procedure<TransportAnchor>): Subscription
}
