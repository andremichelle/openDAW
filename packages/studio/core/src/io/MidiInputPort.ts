import {Exec, Option, Procedure, Subscription} from "@opendaw/lib-std"

// `timeStamp` is the `performance.now()` time the message was received
export type MidiInputMessage = { readonly data: Uint8Array, readonly timeStamp: number }

export interface MidiInputPort {
    // the messages of the device with this id, of every device when there is none or it is gone
    subscribe(deviceId: Option<string>, observer: Procedure<MidiInputMessage>): Subscription
    // access was granted, or a device was plugged in or out
    subscribeDevicesChanged(observer: Exec): Subscription
}
