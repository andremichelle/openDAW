import {asInstanceOf, assert, Errors, Option, Terminable, Terminator} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {AudioUnitType} from "@opendaw/studio-enums"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {ppqn} from "@opendaw/lib-dsp"

export class Recording {
    static get isRecording(): boolean {return this.#isRecording}

    static async start(project: Project, countIn: boolean): Promise<Terminable> {
        if (this.#isRecording) {
            return Promise.resolve(Terminable.Empty)
        }
        this.#isRecording = true
        assert(this.#instance.isEmpty(), "Recording already in progress")
        this.#prepare(project)
        const {captureDevices, engine, editing} = project
        const terminator = new Terminator()
        const captures = captureDevices.filterArmed()
        if (captures.length === 0) {
            this.#isRecording = false
            return Errors.warn("No track is armed for Recording")
        }
        const {status, error} =
            await Promises.tryCatch(Promise.all(captures.map(capture => capture.prepareRecording())))
        if (status === "rejected") {
            this.#isRecording = false
            return Errors.warn(String(error))
        }
        captures.forEach(capture => capture.clearRecordedRegions())
        terminator.ownAll(...captures.map(capture => capture.startRecording()))
        engine.prepareRecordingState(countIn)
        const {isRecording, isCountingIn} = engine
        const stop = (): void => {
            if (isRecording.getValue() || isCountingIn.getValue()) {return}
            editing.modify(() => terminator.terminate()) // finalizes recording
            this.#isRecording = false
        }
        terminator.ownAll(
            engine.isRecording.subscribe(stop),
            engine.isCountingIn.subscribe(stop),
            Terminable.create(() => Recording.#instance = Option.None)
        )
        this.#instance = Option.wrap(new Recording(countIn, engine.position.getValue()))
        return terminator
    }

    static #prepare({api, captureDevices, editing, rootBox, userEditingManager}: Project): void {
        const captures = captureDevices.filterArmed()
        const instruments = rootBox.audioUnits.pointerHub.incoming()
            .map(({box}) => asInstanceOf(box, AudioUnitBox))
            .filter(box => box.type.getValue() === AudioUnitType.Instrument)
        if (instruments.length === 0) {
            const {audioUnitBox} = editing
                .modify(() => api.createInstrument(InstrumentFactories.Tape))
                .unwrap("Could not create Tape")
            captureDevices.get(audioUnitBox.address.uuid)
                .unwrap("Could not unwrap capture")
                .armed.setValue(true)
        } else if (captures.length === 0) {
            userEditingManager.audioUnit.get()
                .ifSome(({box: {address: {uuid}}}) =>
                    captureDevices.get(uuid)
                        .ifSome(capture => capture.armed.setValue(true))) // auto arm editing audio-unit
        }
    }

    static #isRecording: boolean = false

    static #instance: Option<Recording> = Option.None

    static wasCountingIn(): boolean {return this.#instance.mapOr(recording => recording.countIn, () => false)}
    static wasStartingAt(): ppqn {return this.#instance.mapOr(recording => recording.startPosition, () => 0.0)}

    private constructor(readonly countIn: boolean, readonly startPosition: ppqn) {}
}