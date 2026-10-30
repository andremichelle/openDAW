import {
    byte,
    DefaultObservableValue,
    Func,
    int,
    isDefined,
    Notifier,
    ObservableValue,
    Observer,
    Option,
    Optional,
    Subscription,
    Terminable,
    Terminator,
    unitValue
} from "@opendaw/lib-std"
import {MidiData} from "@opendaw/lib-midi"
import {Promises} from "@opendaw/lib-runtime"
import {AudioUnitBox, CaptureMidiBox} from "@opendaw/studio-boxes"
import {NoteSignal} from "@opendaw/studio-adapters"
import {bpm, ppqn, PPQN} from "@opendaw/lib-dsp"
import {MidiDevices} from "../midi"
import {BrowserContextClock, BrowserMidiInput, ContextClock, MidiInputPort} from "../io"
import {Capture} from "./Capture"
import {CaptureDevices} from "./CaptureDevices"
import {RecordMidi} from "./RecordMidi"
import {TransportLog} from "./TransportLog"

// `time` is the audio context time the note was heard at
type RawNoteOn = { type: "on", pitch: byte, velocity: unitValue, time: number }
type RawNoteOff = { type: "off", pitch: byte, time: number }
type RawNoteEvent = RawNoteOn | RawNoteOff

export type ResolvedNote = { pitch: byte, velocity: unitValue, position: ppqn, duration: ppqn }
export type CaptureResult = { mode: "stopped" | "playing", origin: number, notes: ReadonlyArray<ResolvedNote> }

const MIN_NOTE_DURATION: ppqn = PPQN.fromSignature(1, 128)

export class CaptureMidi extends Capture<CaptureMidiBox> {
    readonly #streamGenerator: Func<void, Promise<void>>
    readonly #notifier = new Notifier<NoteSignal>()
    readonly #captureNoteOnCount = new DefaultObservableValue<int>(0)
    readonly #captureSubscriptions = new Terminator()
    readonly #input: MidiInputPort
    readonly #clock: ContextClock
    readonly #captureLog: TransportLog

    #filterChannel: Option<byte> = Option.None
    #stream: Option<Subscription> = Option.None

    #captureEvents: Array<RawNoteEvent> = []
    #captureMode: "stopped" | "playing" = "stopped"
    #captureOrigin: number = 0
    #captureOriginTime: number = 0
    #captureOriginSet: boolean = false
    #capturePendingReset: boolean = false
    #captureBpmAtOrigin: bpm = 120.0

    constructor(manager: CaptureDevices, audioUnitBox: AudioUnitBox, captureMidiBox: CaptureMidiBox,
                input: MidiInputPort = BrowserMidiInput.instance,
                clock: ContextClock = new BrowserContextClock(manager.project.env.audioContext)) {
        super(manager, audioUnitBox, captureMidiBox)
        this.#input = input
        this.#clock = clock
        this.#captureLog = new TransportLog(manager.project.tempoMap)
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
            // the stream snapshots the input devices when arming: access granted later or a hot-plugged device rebuilds it
            input.subscribeDevicesChanged(async () => {
                if (this.armed.getValue()) {
                    await this.#streamGenerator()
                }
            }),
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

    async prepareRecording(): Promise<void> {}

    startRecording(): Terminable {
        return RecordMidi.start({notifier: this.#notifier, project: this.manager.project, capture: this, clock: this.#clock})
    }

    #startCapture(): void {
        this.#captureReset()
        this.#captureSubscriptions.terminate()
        const {engine, env: {audioContext}} = this.manager.project
        this.#captureLog.clear()
        this.#captureSubscriptions.ownAll(
            engine.subscribeTransportAnchors(anchors => anchors.forEach(anchor => this.#captureLog.append(anchor))),
            engine.isPlaying.catchupAndSubscribe(owner => {
                const playing = owner.getValue()
                if (playing) {
                    // armed while the transport ran: no start anchor came, so begin at the render clock
                    const {currentTime} = audioContext
                    if (this.#captureLog.anchorAt(currentTime).mapOr(anchor => anchor.kind === "stop", true)) {
                        this.#captureLog.append({
                            kind: "start", contextTime: currentTime, position: engine.position.getValue(), recording: false
                        })
                    }
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
            const time = this.#timeOf(signal.timeStamp)
            if (!this.#captureOriginSet) {
                this.#captureOriginTime = time
                if (this.#captureMode === "playing") {
                    this.#captureOrigin = this.#captureLog.positionAt(time)
                        .unwrapOrElse(this.manager.project.engine.position.getValue())
                } else {
                    this.#captureOrigin = time * 1000.0
                    this.#captureBpmAtOrigin = this.manager.project.timelineBox.bpm.getValue()
                }
                this.#captureOriginSet = true
            }
            this.#captureEvents.push({type: "on", pitch: signal.pitch, velocity: signal.velocity, time})
            this.#captureNoteOnCount.setValue(this.#captureNoteOnCount.getValue() + 1)
        } else if (NoteSignal.isOff(signal)) {
            this.#captureEvents.push({type: "off", pitch: signal.pitch, time: this.#timeOf(signal.timeStamp)})
        }
    }

    #timeOf(timeStamp: Optional<number>): number {
        const stamp = isDefined(timeStamp) ? Math.min(timeStamp, performance.now()) : performance.now()
        return this.#clock.audibleTimeAt(stamp) - this.manager.project.engine.compensationLatency.getValue()
    }

    #captureReset(): void {
        this.#captureEvents.length = 0
        this.#captureNoteOnCount.setValue(0)
        this.#captureOrigin = 0
        this.#captureOriginTime = 0
        this.#captureOriginSet = false
        this.#capturePendingReset = false
        this.#captureBpmAtOrigin = 120.0
    }

    #resolveNotes(): Array<ResolvedNote> {
        const openNotes = new Map<byte, { velocity: unitValue, time: number }>()
        const resolved: Array<ResolvedNote> = []
        const toPosition = (time: number): ppqn => {
            if (this.#captureMode === "playing" || this.#capturePendingReset) {
                return this.#captureLog.advance(this.#captureOriginTime, time)
            }
            return PPQN.secondsToPulses(time - this.#captureOriginTime, this.#captureBpmAtOrigin)
        }
        const commitTime = this.#timeOf(undefined)
        for (const event of this.#captureEvents) {
            if (event.type === "on") {
                openNotes.set(event.pitch, {velocity: event.velocity, time: event.time})
            } else {
                const open = openNotes.get(event.pitch)
                if (!isDefined(open)) {continue}
                openNotes.delete(event.pitch)
                const position = toPosition(open.time)
                const duration = Math.max(MIN_NOTE_DURATION, toPosition(event.time) - position)
                resolved.push({pitch: event.pitch, velocity: open.velocity, position, duration})
            }
        }
        for (const [pitch, open] of openNotes) {
            const position = toPosition(open.time)
            const duration = Math.max(MIN_NOTE_DURATION, toPosition(commitTime) - position)
            resolved.push({pitch, velocity: open.velocity, position, duration})
        }
        // Sort by position so notes[0] is the earliest press, not the first note-off.
        // commitMidiCapture relies on this to anchor firstPosition and place chord
        // notes at non-negative relative positions.
        return resolved.sort((left, right) => left.position - right.position)
    }

    async #updateStream() {
        const activeNotes = new Int8Array(128)
        this.#stream.ifSome(terminable => terminable.terminate())
        this.#stream = Option.wrap(Terminable.many(
            this.#input.subscribe(this.deviceId.getValue(), ({data, timeStamp}) => {
                if (!this.#filterChannel.mapOr(channel => MidiData.readChannel(data) === channel, true)) {return}
                const pitch = MidiData.readPitch(data)
                if (MidiData.isNoteOn(data)) {
                    activeNotes[pitch]++
                    this.#notifier.notify({type: "note-on", uuid: this.uuid, pitch, velocity: MidiData.readVelocity(data), timeStamp})
                } else if (MidiData.isNoteOff(data) && activeNotes[pitch] > 0) {
                    activeNotes[pitch]--
                    this.#notifier.notify({type: "note-off", uuid: this.uuid, pitch, timeStamp})
                }
            }),
            Terminable.create(() => activeNotes.forEach((count, pitch) => {
                for (let index = 0; index < count * 16; index++) {
                    this.#notifier.notify({type: "note-off", uuid: this.uuid, pitch, timeStamp: performance.now()})
                }
            }))))
    }

    #stopStream(): void {
        this.#stream.ifSome(terminable => terminable.terminate())
        this.#stream = Option.None
    }
}