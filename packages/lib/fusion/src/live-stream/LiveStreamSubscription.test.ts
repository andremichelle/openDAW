// Issue 429: a packet the broadcaster wrote while the subscription flag still read 0 carries an array the `before`
// callback never filled. A subscriber added after that flush but before the receiver reads it must not get it.
import {afterEach, describe, expect, it} from "vitest"
import {MessageChannel} from "node:worker_threads"
import {Terminable, UUID} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {Messenger, Port} from "@opendaw/lib-runtime"
import {LiveStreamBroadcaster} from "./LiveStreamBroadcaster"
import {LiveStreamReceiver} from "./LiveStreamReceiver"

const address = Address.compose(UUID.parse("22222222-2222-4000-8000-000000000000"), 7)
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

describe("LiveStream subscription edge", () => {
    const terminables: Array<Terminable> = []
    afterEach(() => terminables.splice(0).forEach(terminable => terminable.terminate()))

    const setup = () => {
        const {port1, port2} = new MessageChannel()
        terminables.push({terminate: () => {port1.close(); port2.close()}})
        const broadcaster = LiveStreamBroadcaster.create(Messenger.for(port1 as unknown as Port), "live")
        const receiver = new LiveStreamReceiver()
        terminables.push(receiver.connect(Messenger.for(port2 as unknown as Port).channel("live")), receiver, broadcaster)
        const values = new Float32Array(5)
        broadcaster.broadcastFloats(address, values, hasSubscribers => {if (hasSubscribers) {values.fill(-120)}})
        return {broadcaster, receiver, values}
    }

    it("never delivers a packet written while nobody was subscribed", async () => {
        const {broadcaster, receiver} = setup()
        broadcaster.flush() // structure, SAB and a first packet written with the flag at 0
        await settle()
        const received: Array<Array<number>> = []
        receiver.subscribeFloats(address, array => received.push(Array.from(array)))
        receiver.dispatch()
        broadcaster.flush()
        receiver.dispatch()
        broadcaster.flush()
        receiver.dispatch()
        expect(received.length).toBeGreaterThan(0)
        for (const packet of received) {expect(packet).toEqual([-120, -120, -120, -120, -120])}
    })

    it("a re-subscriber never gets the values left over from before it subscribed", async () => {
        const {broadcaster, receiver, values} = setup()
        broadcaster.flush()
        await settle()
        const first = receiver.subscribeFloats(address, () => {})
        receiver.dispatch()
        broadcaster.flush()
        receiver.dispatch()
        first.terminate()
        broadcaster.flush() // written with the flag still at 1
        receiver.dispatch()
        values.fill(42) // stale contents the processor would not overwrite without subscribers
        broadcaster.flush() // written with the flag at 0: values not refreshed
        const received: Array<Array<number>> = []
        receiver.subscribeFloats(address, array => received.push(Array.from(array)))
        receiver.dispatch()
        broadcaster.flush()
        receiver.dispatch()
        expect(received.length).toBeGreaterThan(0)
        for (const packet of received) {expect(packet).toEqual([-120, -120, -120, -120, -120])}
    })
})
