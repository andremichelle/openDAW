import {
    assert,
    byte,
    clamp,
    DefaultObservableValue,
    int,
    isNull,
    Nullable,
    ObservableValue,
    safeExecute,
    unitValue
} from "@moises-ai/lib-std"
import {MidiData} from "@moises-ai/lib-midi"

type OnMidiMessage = Nullable<(this: MIDIInput, ev: MIDIMessageEvent) => any>

type OnStateChange = Nullable<(this: MIDIPort, ev: MIDIConnectionEvent) => any>

export class SoftwareMIDIInput implements MIDIInput {
    readonly manufacturer: string | null = "openDAW"
    readonly connection: MIDIPortConnectionState = "open"
    readonly id: string = "software-midi-input"
    readonly name: string | null = "Software Keyboard"
    readonly state: MIDIPortDeviceState = "connected"
    readonly type: MIDIPortType = "input"
    readonly version: string | null = "1.0.0"

    readonly #dispatcher: EventTarget
    readonly #countListeners: DefaultObservableValue<int>
    readonly #activeNotes: Uint8Array

    onstatechange: OnStateChange = null // has no effect. this device is always connected.

    #onmidimessage: OnMidiMessage = null
    #channel: byte = 0 // 0...15

    constructor() {
        this.#dispatcher = new EventTarget()
        this.#countListeners = new DefaultObservableValue(0)
        this.#activeNotes = new Uint8Array(128)
    }

    get onmidimessage(): OnMidiMessage {return this.#onmidimessage}
    set onmidimessage(value: OnMidiMessage) {
        this.#onmidimessage = value
        if (isNull(value)) {this.#changeListenerCount(-1)} else {this.#changeListenerCount(1)}
    }

    get countListeners(): ObservableValue<int> {return this.#countListeners}

    sendNoteOn(note: byte, velocity: unitValue = 1.0): void {
        assert(note >= 0 && note <= 127, `Note must be between 0 and 127, but was ${note}`)
        this.#activeNotes[note]++
        const velocityByte = Math.round(clamp(velocity, 0.0, 1.0) * 127.0)
        this.#sendMIDIMessageData(MidiData.noteOn(this.#channel, note, velocityByte))
    }

    sendNoteOff(note: byte): void {
        assert(note >= 0 && note <= 127, `Note must be between 0 and 127, but was ${note}`)
        this.#activeNotes[note]--
        this.#sendMIDIMessageData(MidiData.noteOff(this.#channel, note))
        assert(this.#activeNotes[note] >= 0, "Negative count of active notes")
    }

    releaseAllNotes(): void {
        this.#activeNotes.forEach((count, note) => {
            for (let i = 0; i < count; i++) {
                this.#sendMIDIMessageData(MidiData.noteOff(this.#channel, note))
            }
        })
        this.#activeNotes.fill(0)
    }

    hasActiveNote(note: byte): boolean {return this.#activeNotes[note] > 0}
    hasActiveNotes(): boolean {return this.#activeNotes.some(count => count > 0)}

    get channel(): byte {return this.#channel}
    set channel(value: byte) {
        if (this.#channel === value) {return}
        this.releaseAllNotes()
        this.#channel = value
    }

    open(): Promise<MIDIPort> {return Promise.resolve(this)}
    close(): Promise<MIDIPort> {return Promise.resolve(this)}
    addEventListener<K extends keyof MIDIInputEventMap>(type: K, listener: (this: MIDIInput, ev: MIDIInputEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void
    addEventListener<K extends keyof MIDIPortEventMap>(type: K, listener: (this: MIDIPort, ev: MIDIPortEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
        this.#dispatcher.addEventListener(type, listener, options)
        this.#changeListenerCount(1)
    }
    dispatchEvent(event: MIDIMessageEvent): boolean {
        safeExecute(this.#onmidimessage, event)
        return this.#dispatcher.dispatchEvent(event)
    }
    removeEventListener<K extends keyof MIDIInputEventMap>(type: K, listener: (this: MIDIInput, ev: MIDIInputEventMap[K]) => any, options?: boolean | EventListenerOptions): void
    removeEventListener<K extends keyof MIDIPortEventMap>(type: K, listener: (this: MIDIPort, ev: MIDIPortEventMap[K]) => any, options?: boolean | EventListenerOptions): void
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void {
        this.#dispatcher.removeEventListener(type, listener, options)
        this.#changeListenerCount(-1)
    }

    #sendMIDIMessageData(data: Uint8Array): void {
        const eventInit: MessageEventInit = {data}
        this.dispatchEvent(new MessageEvent("midimessage", eventInit))
    }

    #changeListenerCount(delta: -1 | 1): void {
        this.#countListeners.setValue(this.#countListeners.getValue() + delta)
    }
}