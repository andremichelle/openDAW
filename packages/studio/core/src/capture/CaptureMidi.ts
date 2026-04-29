import {
    byte,
    DefaultObservableValue,
    Errors,
    Func,
    int,
    isDefined,
    isUndefined,
    Notifier,
    ObservableValue,
    Observer,
    Option,
    Subscription,
    Terminable,
    Terminator,
    unitValue
} from "@opendaw/lib-std"
import {Events} from "@opendaw/lib-dom"
import {MidiData} from "@opendaw/lib-midi"
import {Promises} from "@opendaw/lib-runtime"
import {AudioUnitBox, CaptureMidiBox} from "@opendaw/studio-boxes"
import {NoteSignal} from "@opendaw/studio-adapters"
import {bpm, ppqn, PPQN} from "@opendaw/lib-dsp"
import {MidiDevices} from "../midi"
import {Capture} from "./Capture"
import {CaptureDevices} from "./CaptureDevices"
import {RecordMidi} from "./RecordMidi"

type RawNoteOn = { type: "on", pitch: byte, velocity: unitValue, delta: number }
type RawNoteOff = { type: "off", pitch: byte, delta: number }
type RawNoteEvent = RawNoteOn | RawNoteOff

export type ResolvedNote = { pitch: byte, velocity: unitValue, position: ppqn, duration: ppqn }
export type CaptureResult = { mode: "stopped" | "playing", origin: number, notes: ReadonlyArray<ResolvedNote> }

const MIN_NOTE_DURATION: ppqn = PPQN.fromSignature(1, 128)

export class CaptureMidi extends Capture<CaptureMidiBox> {
    readonly #streamGenerator: Func<void, Promise<void>>
    readonly #notifier = new Notifier<NoteSignal>()
    readonly #captureNoteOnCount = new DefaultObservableValue<int>(0)
    readonly #captureSubscriptions = new Terminator()

    #filterChannel: Option<byte> = Option.None
    #stream: Option<Subscription> = Option.None

    #captureEvents: Array<RawNoteEvent> = []
    #captureMode: "stopped" | "playing" = "stopped"
    #captureOrigin: number = 0
    #captureOriginSet: boolean = false
    #capturePendingReset: boolean = false
    #captureBpmAtOrigin: bpm = 120.0
    #captureLoopOffset: ppqn = 0
    #captureLastPosition: ppqn = 0

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
                    this.#startCapture()
                    await this.#streamGenerator()
                } else {
                    this.#stopCapture()
                    this.#stopStream()
                }
            }),
            this.#notifier.subscribe((signal: NoteSignal) => manager.project.engine.noteSignal(signal)),
            this.#notifier.subscribe((signal: NoteSignal) => this.#bufferNote(signal)),
            Terminable.create(() => {
                this.#stopStream()
                this.#stopCapture()
            })
        )
    }

    get captureNoteOnCount(): ObservableValue<int> {return this.#captureNoteOnCount}

    resolveCapture(): Option<CaptureResult> {
        const notes = this.#resolveNotes()
        if (notes.length === 0) {return Option.None}
        return Option.wrap({mode: this.#captureMode, origin: this.#captureOrigin, notes})
    }

    resetCapture(): void {
        this.#captureReset()
        this.#captureMode = this.manager.project.engine.isPlaying.getValue() ? "playing" : "stopped"
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

    #startCapture(): void {
        this.#captureReset()
        this.#captureSubscriptions.terminate()
        const {engine, timelineBox} = this.manager.project
        const {loopArea} = timelineBox
        this.#captureSubscriptions.ownAll(
            engine.isPlaying.catchupAndSubscribe(owner => {
                const playing = owner.getValue()
                if (playing) {
                    this.#captureReset()
                    this.#captureMode = "playing"
                } else if (this.#captureEvents.length > 0) {
                    this.#capturePendingReset = true
                } else {
                    this.#captureReset()
                    this.#captureMode = "stopped"
                }
            }),
            engine.isRecording.catchupAndSubscribe(owner => {
                if (owner.getValue()) {this.#captureReset()}
            }),
            engine.position.subscribe(owner => {
                if (this.#captureMode !== "playing") {return}
                const currentPosition = owner.getValue()
                if (!this.#captureOriginSet) {
                    this.#captureOrigin = currentPosition
                    this.#captureLastPosition = currentPosition
                    this.#captureOriginSet = true
                    return
                }
                if (currentPosition < this.#captureLastPosition && loopArea.enabled.getValue()) {
                    this.#captureLoopOffset += loopArea.to.getValue() - loopArea.from.getValue()
                }
                this.#captureLastPosition = currentPosition
            })
        )
    }

    #stopCapture(): void {
        this.#captureSubscriptions.terminate()
        this.#captureReset()
    }

    #bufferNote(signal: NoteSignal): void {
        if (!this.armed.getValue()) {return}
        if (this.manager.project.engine.isRecording.getValue()) {return}
        if (NoteSignal.isOn(signal)) {
            if (this.#capturePendingReset) {
                this.#captureReset()
                this.#captureMode = "stopped"
                this.#capturePendingReset = false
            }
            if (!this.#captureOriginSet) {
                if (this.#captureMode === "playing") {
                    const currentPosition = this.manager.project.engine.position.getValue()
                    this.#captureOrigin = currentPosition
                    this.#captureLastPosition = currentPosition
                } else {
                    this.#captureOrigin = performance.now()
                    this.#captureBpmAtOrigin = this.manager.project.timelineBox.bpm.getValue()
                }
                this.#captureOriginSet = true
            }
            const delta = this.#computeCaptureDelta()
            this.#captureEvents.push({type: "on", pitch: signal.pitch, velocity: signal.velocity, delta})
            this.#captureNoteOnCount.setValue(this.#captureNoteOnCount.getValue() + 1)
        } else if (NoteSignal.isOff(signal)) {
            const delta = this.#computeCaptureDelta()
            this.#captureEvents.push({type: "off", pitch: signal.pitch, delta})
        }
    }

    #computeCaptureDelta(): number {
        if (this.#captureMode === "playing") {
            return this.#captureLastPosition - this.#captureOrigin + this.#captureLoopOffset
        }
        return performance.now() - this.#captureOrigin
    }

    #captureReset(): void {
        this.#captureEvents.length = 0
        this.#captureNoteOnCount.setValue(0)
        this.#captureOrigin = 0
        this.#captureOriginSet = false
        this.#capturePendingReset = false
        this.#captureBpmAtOrigin = 120.0
        this.#captureLoopOffset = 0
        this.#captureLastPosition = 0
    }

    #resolveNotes(): Array<ResolvedNote> {
        const openNotes = new Map<byte, { velocity: unitValue, delta: number }>()
        const resolved: Array<ResolvedNote> = []
        const toPosition = (delta: number): ppqn => {
            if (this.#captureMode === "playing" || this.#capturePendingReset) {return delta}
            return PPQN.secondsToPulses(delta / 1000, this.#captureBpmAtOrigin)
        }
        const commitDelta = this.#computeCaptureDelta()
        for (const event of this.#captureEvents) {
            if (event.type === "on") {
                openNotes.set(event.pitch, {velocity: event.velocity, delta: event.delta})
            } else {
                const open = openNotes.get(event.pitch)
                if (!isDefined(open)) {continue}
                openNotes.delete(event.pitch)
                const position = toPosition(open.delta)
                const duration = Math.max(MIN_NOTE_DURATION, toPosition(event.delta) - position)
                resolved.push({pitch: event.pitch, velocity: open.velocity, position, duration})
            }
        }
        for (const [pitch, open] of openNotes) {
            const position = toPosition(open.delta)
            const duration = Math.max(MIN_NOTE_DURATION, toPosition(commitDelta) - position)
            resolved.push({pitch, velocity: open.velocity, position, duration})
        }
        return resolved
    }

    async #updateStream() {
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