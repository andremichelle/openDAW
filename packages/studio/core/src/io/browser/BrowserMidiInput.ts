import {Exec, isDefined, Option, Procedure, Subscription, Terminable, Terminator} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {MidiDevices} from "../../midi"
import {MidiInputMessage, MidiInputPort} from "../MidiInputPort"
import {MidiClock} from "./MidiClock"

export class BrowserMidiInput implements MidiInputPort {
    static readonly instance: BrowserMidiInput = new BrowserMidiInput()

    readonly #clock: MidiClock = new MidiClock()

    private constructor() {}

    subscribe(deviceId: Option<string>, observer: Procedure<MidiInputMessage>): Subscription {
        const inputs = MidiDevices.inputDevices()
        const selected = deviceId.match({
            none: () => inputs,
            some: id => {
                const filtered = inputs.filter(device => id === device.id)
                if (filtered.length === 0 && inputs.length > 0) {
                    console.warn(`Requested MIDI device '${id}' unavailable, listening to all devices`)
                    return inputs
                }
                return filtered
            }
        })
        return Terminable.many(...selected.map(input => Events.subscribe(input, "midimessage", (event: MIDIMessageEvent) => {
            const data = event.data
            if (isDefined(data)) {
                observer({data, timeStamp: this.#clock.toPerformanceTime(event.timeStamp, performance.now())})
            }
        })))
    }

    subscribeDevicesChanged(observer: Exec): Subscription {
        const terminator = new Terminator()
        const access = terminator.own(new Terminator())
        terminator.own(MidiDevices.available().subscribe(() => {
            access.terminate()
            MidiDevices.get().ifSome(midiAccess => access.own(Events.subscribe(midiAccess, "statechange", observer)))
            observer()
        }))
        MidiDevices.get().ifSome(midiAccess => access.own(Events.subscribe(midiAccess, "statechange", observer)))
        return terminator
    }
}
