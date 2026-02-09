import {
    byte,
    Errors,
    Func,
    isDefined,
    isUndefined,
    Notifier,
    Observer,
    Option,
    Subscription,
    Terminable
} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {MidiData} from "@opendaw/lib-midi"
import {Promises} from "@opendaw/lib-runtime"
import {AudioUnitBox, CaptureMidiBox} from "@opendaw/studio-boxes"
import {NoteSignal} from "@opendaw/studio-adapters"
import {MidiDevices} from "../midi"
import {Capture} from "./Capture"
import {CaptureDevices} from "./CaptureDevices"
import {RecordMidi} from "./RecordMidi"

export class CaptureMidi extends Capture<CaptureMidiBox> {
    readonly #streamGenerator: Func<void, Promise<void>>
    readonly #notifier = new Notifier<NoteSignal>()

    #filterChannel: Option<byte> = Option.None
    #stream: Option<Subscription> = Option.None

    constructor(manager: CaptureDevices, audioUnitBox: AudioUnitBox, captureMidiBox: CaptureMidiBox) {
        super(manager, audioUnitBox, captureMidiBox)

        this.#streamGenerator = Promises.sequentialize(() => this.#updateStream())

        this.ownAll(
            captureMidiBox.channel.catchupAndSubscribe(async owner => {
                const channel = owner.getValue()
                this.#filterChannel = channel >= 0 ? Option.wrap(channel) : Option.None
                if (this.armed.getValue()) {
                    await this.#streamGenerator()
                }
            }),
            captureMidiBox.deviceId.subscribe(async () => {
                if (this.armed.getValue()) {
                    await this.#streamGenerator()
                }
            }),
            this.armed.catchupAndSubscribe(async owner => {
                const armed = owner.getValue()
                if (armed) {
                    await this.#streamGenerator()
                } else {
                    this.#stopStream()
                }
            }),
            this.#notifier.subscribe((signal: NoteSignal) => manager.project.engine.noteSignal(signal)),
            Terminable.create(() => this.#stopStream())
        )
    }

    notify(signal: NoteSignal): void {this.#notifier.notify(signal)}

    subscribeNotes(observer: Observer<NoteSignal>): Subscription {return this.#notifier.subscribe(observer)}

    get label(): string {
        return MidiDevices.get().mapOr(() => this.deviceId.getValue().match({
            none: () => this.armed.getValue() ? this.#filterChannel.match({
                none: () => `Listening to all devices`,
                some: channel => `Listening to all devices on channel '${channel}'`
            }) : "Arm to listen to MIDI device...",
            some: id => {
                const device = MidiDevices.findInputDeviceById(id)
                if (device.isEmpty()) {return `Could not find device with id '${id}'`}
                const deviceName = device.unwrapOrUndefined()?.name ?? "Unknown device"
                return this.#filterChannel.match({
                    none: () => `Listening to ${deviceName}`,
                    some: channel => `Listening to ${deviceName} on channel #${channel + 1}`
                })
            }
        }), "MIDI not available")
    }

    get deviceLabel(): Option<string> {
        return this.deviceId.getValue()
            .flatMap(deviceId => MidiDevices.findInputDeviceById(deviceId)
                .map(device => device.name))
    }

    async prepareRecording(): Promise<void> {
        if (MidiDevices.get().isEmpty()) {
            if (MidiDevices.canRequestMidiAccess()) {
                await MidiDevices.requestPermission()
            } else {
                return Errors.warn("MIDI not available")
            }
        }
        const inputs = MidiDevices.inputDevices()
        if (inputs.length === 0) {return}
        const option = this.deviceId.getValue()
        if (option.nonEmpty()) {
            const deviceId = option.unwrap()
            if (isUndefined(inputs.find(device => deviceId === device.id))) {
                return Errors.warn(`Could not find MIDI device with id: '${deviceId}'`)
            }
        }
    }

    startRecording(): Terminable {
        return RecordMidi.start({notifier: this.#notifier, project: this.manager.project, capture: this})
    }

    async #updateStream() {
        if (MidiDevices.get().isEmpty() && MidiDevices.canRequestMidiAccess()) {await MidiDevices.requestPermission()}
        const inputs = MidiDevices.inputDevices()
        const explicit = this.deviceId.getValue().match({
            none: () => inputs,
            some: id => inputs.filter(device => id === device.id)
        })
        const activeNotes = new Int8Array(128)
        this.#stream.ifSome(terminable => terminable.terminate())
        this.#stream = Option.wrap(Terminable.many(
            ...explicit.map(input => Events.subscribe(input, "midimessage", (event: MIDIMessageEvent) => {
                const data = event.data
                if (isDefined(data) &&
                    this.#filterChannel.mapOr(channel => MidiData.readChannel(data) === channel, true)) {
                    const pitch = MidiData.readPitch(data)
                    if (MidiData.isNoteOn(data)) {
                        activeNotes[pitch]++
                        this.#notifier.notify(NoteSignal.fromEvent(event, this.uuid))
                    } else if (MidiData.isNoteOff(data) && activeNotes[pitch] > 0) {
                        activeNotes[pitch]--
                        this.#notifier.notify(NoteSignal.fromEvent(event, this.uuid))
                    }
                }
            })),
            Terminable.create(() => activeNotes.forEach((count, index) => {
                if (count > 0) {
                    for (let channel = 0; channel < 16; channel++) {
                        const event = new MessageEvent("midimessage", {data: MidiData.noteOff(channel, index)})
                        const signal = NoteSignal.fromEvent(event, this.uuid)
                        for (let i = 0; i < count; i++) {
                            this.#notifier.notify(signal)
                        }
                    }
                }
            }))))
    }

    #stopStream(): void {
        this.#stream.ifSome(terminable => terminable.terminate())
        this.#stream = Option.None
    }
}