import {assert, Errors, Option, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {Project} from "../project"
import {ppqn} from "@opendaw/lib-dsp"
import {RecordAutomation} from "./RecordAutomation"

export class Recording {
    static get isRecording(): boolean {return this.#isRecording}

    static async start(project: Project, countIn: boolean): Promise<Terminable> {
        if (this.#isRecording) {
            return Promise.resolve(Terminable.Empty)
        }
        this.#isRecording = true
        assert(this.#instance.isEmpty(), "Recording already in progress")
        const {captureDevices, engine, editing} = project
        const terminator = new Terminator()
        const captures = captureDevices.filterArmed()
        if (captures.length > 0) {
            const {status, error} =
                await Promises.tryCatch(Promise.all(captures.map(capture => capture.prepareRecording())))
            if (status === "rejected") {
                this.#isRecording = false
                return Errors.warn(String(error))
            }
            captures.forEach(capture => capture.clearRecordedRegions())
            terminator.ownAll(...captures.map(capture => capture.startRecording()))
        }
        terminator.own(RecordAutomation.start(project))
        const armedUUIDs = UUID.newSet<UUID.Bytes>(uuid => uuid)
        captures.forEach(capture => armedUUIDs.add(capture.audioUnitBox.address.uuid))
        project.regionSelection.deselect(...project.regionSelection.selected()
            .filter(region => region.trackBoxAdapter
                .mapOr(track => armedUUIDs.hasKey(track.audioUnit.address.uuid), () => false)))
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

    static #isRecording: boolean = false

    static #instance: Option<Recording> = Option.None

    static wasCountingIn(): boolean {return this.#instance.mapOr(recording => recording.countIn, () => false)}
    static wasStartingAt(): ppqn {return this.#instance.mapOr(recording => recording.startPosition, () => 0.0)}

    private constructor(readonly countIn: boolean, readonly startPosition: ppqn) {}
}