import {
    byte,
    Errors,
    Lazy,
    MutableObservableOption,
    MutableObservableValue,
    Notifier,
    ObservableOption,
    ObservableValue,
    Observer,
    Option,
    panic,
    Procedure,
    Subscription,
    Terminator,
    UUID
} from "@moises-ai/lib-std"
import {MidiData} from "@moises-ai/lib-midi"
import {Promises} from "@moises-ai/lib-runtime"
import {MIDIMessageSubscriber} from "./MIDIMessageSubscriber"
import {SoftwareMIDIInput} from "./SoftwareMIDIInput"

export class MidiDevices {
    static canRequestMidiAccess(): boolean {return "requestMIDIAccess" in navigator}

    static readonly softwareMIDIInput: SoftwareMIDIInput = new SoftwareMIDIInput()

    static readonly #softwareMIDIOutputs: Map<string, MIDIOutput> = new Map<string, MIDIOutput>()

    static createSoftwareMIDIOutput(procedure: Procedure<Uint8Array>, name: string, id?: string): MIDIOutput {
        const output = new class implements MIDIOutput {
            readonly id: string = id ?? UUID.toString(UUID.generate())
            readonly name: string = name
            readonly manufacturer: string | null = null
            readonly state: MIDIPortDeviceState = "connected"
            readonly connection: MIDIPortConnectionState = "open"
            readonly type: MIDIPortType = "output"
            readonly version: string | null = null

            send(data: unknown, _timestamp?: number): void {
                if (data instanceof Uint8Array) {
                    procedure(data)
                } else if (Array.isArray(data) && data.every(value => typeof value === "number")) {
                    procedure(new Uint8Array(data))
                } else {
                    return panic("MIDI output data must be an array of numbers or a Uint8Array")
                }
            }
            addEventListener(_type: unknown, _listener: unknown, _options?: unknown): void {}
            removeEventListener(_type: unknown, _listener: unknown, _options?: unknown): void {}
            close(): Promise<MIDIPort> {return Promise.resolve(this)}
            open(): Promise<MIDIPort> {return Promise.resolve(this)}
            dispatchEvent(_event: unknown): boolean {return false}
            onstatechange: ((this: MIDIPort, ev: MIDIConnectionEvent) => any) | null = null
        }
        MidiDevices.#softwareMIDIOutputs.set(output.id, output)
        return output
    }

    static #memoizedRequest = Promises.memoizeAsync(() => navigator.requestMIDIAccess({sysex: false}))

    static async requestPermission() {
        if (this.canRequestMidiAccess()) {
            const {status, value: midiAccess, error} =
                await Promises.tryCatch(this.#memoizedRequest())
            if (status === "rejected") {
                console.warn(error)
                return Errors.warn("Could not request MIDI")
            }
            const numberOfInputs = midiAccess.inputs.size
            const numberOfOutputs = midiAccess.outputs.size
            console.debug(`MIDI access granted: ${numberOfInputs} inputs, ${numberOfOutputs} outputs`)
            this.#midiAccess.wrap(midiAccess)
        } else {
            return Errors.warn("This browser does not support MIDI")
        }
    }

    static get(): ObservableOption<MIDIAccess> {return this.#midiAccess}

    static subscribeMessageEvents(observer: Observer<MIDIMessageEvent>, channel?: byte): Subscription {
        return this.get().match({
            none: () => {
                const terminator = new Terminator()
                terminator.own(this.available().subscribe(() => terminator.own(this.subscribeMessageEvents(observer, channel))))
                return terminator
            },
            some: midi => MIDIMessageSubscriber.subscribeMessageEvents(midi, observer, channel)
        })
    }

    static inputDevices(): ReadonlyArray<MIDIInput> {
        return this.externalInputDevices()
            .mapOr((inputs) => Array.from(inputs.values()).concat(this.softwareMIDIInput), [this.softwareMIDIInput])
    }

    static outputDevices(): ReadonlyArray<MIDIOutput> {
        const softwareOutputs = Array.from(this.#softwareMIDIOutputs.values())
        return this.externalOutputDevices()
            .mapOr((inputs) => Array.from(inputs.values()).concat(...softwareOutputs), softwareOutputs)
    }

    static findInputDeviceById(id: string): Option<MIDIInput> {
        return Option.wrap(this.inputDevices().find(input => input.id === id))
    }

    static findOutputDeviceById(id: string): Option<MIDIOutput> {
        return Option.wrap(this.outputDevices().find(output => output.id === id))
    }

    static externalInputDevices(): Option<ReadonlyArray<MIDIInput>> {
        return this.get().map(({inputs}) => Array.from(inputs.values()))
    }

    static externalOutputDevices(): Option<ReadonlyArray<MIDIOutput>> {
        return this.get().map(({outputs}) => Array.from(outputs.values()))
    }

    static panic(): void {
        this.get().ifSome((midiAccess: MIDIAccess) => {
            for (let note = 0; note < 128; note++) {
                for (let channel = 0; channel < 16; channel++) {
                    const data = MidiData.noteOff(channel, note)
                    const event = new MessageEvent("midimessage", {data})
                    for (let input of midiAccess.inputs.values()) {
                        input.dispatchEvent(event)
                    }
                    for (let output of midiAccess.outputs.values()) {
                        output.send(data)
                    }
                }
            }
        })
    }

    @Lazy
    static available(): MutableObservableValue<boolean> {
        const scope = this
        return new class implements MutableObservableValue<boolean> {
            readonly #notifier: Notifier<ObservableValue<boolean>> = new Notifier<ObservableValue<boolean>>()

            constructor() {
                const subscription = scope.get().subscribe(option => {
                    if (option.nonEmpty()) {
                        subscription.terminate()
                        this.#notifier.notify(this)
                    } // MIDIAccess cannot be turned off
                })
            }

            setValue(value: boolean): void {
                if (!value || scope.#midiAccess.nonEmpty() || scope.#isRequesting) {return}
                console.debug("Request MIDI access")
                scope.#isRequesting = true
                scope.requestPermission().finally(() => scope.#isRequesting = false)
            }

            getValue(): boolean {return scope.#midiAccess.nonEmpty()}

            catchupAndSubscribe(observer: Observer<ObservableValue<boolean>>): Subscription {
                observer(this)
                return this.#notifier.subscribe(observer)
            }

            subscribe(observer: Observer<ObservableValue<boolean>>): Subscription {
                return this.#notifier.subscribe(observer)
            }
        }
    }

    static #isRequesting: boolean = false

    static #midiAccess: MutableObservableOption<MIDIAccess> = new MutableObservableOption<MIDIAccess>()
}