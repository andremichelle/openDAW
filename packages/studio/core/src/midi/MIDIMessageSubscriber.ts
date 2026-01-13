import {byte, isDefined, isInstanceOf, Nullable, Observer, Subscription} from "@moises-ai/lib-std"
import {Events} from "@moises-ai/lib-dom"
import {MidiData} from "@moises-ai/lib-midi"

export class MIDIMessageSubscriber {
    static subscribeMessageEvents(access: MIDIAccess, observer: Observer<MIDIMessageEvent>, channel?: byte): Subscription {
        const listenToMIDIMessages = (input: MIDIInput) => isDefined(channel)
            ? Events.subscribe(input, "midimessage", (event: MIDIMessageEvent) => {
                if (event.data === null || MidiData.readChannel(event.data) !== channel) {return}
                observer(event)
            }) : Events.subscribe(input, "midimessage", observer)
        const connections: Array<[MIDIInput, Subscription]> = Array.from(access.inputs.values())
            .map(input => ([input, listenToMIDIMessages(input)]))
        const stateSubscription = Events.subscribe(access, "statechange", (event: MIDIConnectionEvent) => {
            const port: Nullable<MIDIPort> = event.port
            if (!isInstanceOf(port, MIDIInput)) {return}
            for (const [input, subscription] of connections) {
                if (input === port) {
                    // Well, this seems odd, but if you start listening to a midi-input initially,
                    // it will change its state to 'connected', so we clean up the first old subscriptions.
                    subscription.terminate()
                    break
                }
            }
            if (port.state === "connected") {
                connections.push([port, listenToMIDIMessages(port)])
            }
        })
        return {
            terminate: () => {
                stateSubscription.terminate()
                connections.forEach(([_, subscription]) => subscription.terminate())
                connections.length = 0
            }
        }
    }
}