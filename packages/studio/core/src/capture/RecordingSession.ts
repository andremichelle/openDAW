import {Errors, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {ppqn} from "@opendaw/lib-dsp"
import {TransportAnchor} from "@opendaw/studio-adapters"
import {Project} from "../project"
import {RecordAutomation} from "./RecordAutomation"

// one recording at a time per project: arms the captures, drives the engine, finalizes on the engine's stop
export class RecordingSession {
    static #active: number = 0

    // any project records
    static get anyRecording(): boolean {return this.#active > 0}

    readonly #project: Project

    #isRecording: boolean = false
    #countIn: boolean = false
    #startPosition: ppqn = 0.0

    constructor(project: Project) {this.#project = project}

    get isRecording(): boolean {return this.#isRecording}
    get wasCountingIn(): boolean {return this.#countIn}
    get startPosition(): ppqn {return this.#startPosition}

    async start(countIn: boolean): Promise<Terminable> {
        if (this.#isRecording) {return Terminable.Empty}
        this.#setRecording(true)
        const project = this.#project
        const {captureDevices, engine, editing} = project
        const terminator = new Terminator()
        const captures = captureDevices.filterArmed()
        if (captures.length > 0) {
            const {status, error} =
                await Promises.tryCatch(Promise.all(captures.map(capture => capture.prepareRecording())))
            if (status === "rejected") {
                this.#setRecording(false)
                return Errors.warn(String(error))
            }
            captures.forEach(capture => capture.clearRecordedRegions())
            terminator.ownAll(...captures.map(capture => capture.startRecording()))
        }
        if (engine.preferences.settings.recording.automationEnabled) {
            terminator.own(RecordAutomation.start(project))
        }
        const armedUUIDs = UUID.newSet<UUID.Bytes>(uuid => uuid)
        captures.forEach(capture => armedUUIDs.add(capture.audioUnitBox.address.uuid))
        project.regionSelection.deselect(...project.regionSelection.selected()
            .filter(region => region.trackBoxAdapter
                .mapOr(track => track.optAudioUnit
                    .mapOr(unit => armedUUIDs.hasKey(unit.address.uuid), false), () => false)))
        engine.prepareRecordingState(countIn)
        const {isRecording, isCountingIn} = engine
        let finished = false
        const finish = (): void => {
            if (finished) {return}
            finished = true
            editing.modify(() => terminator.terminate(), false) // finalizes recording
            this.#setRecording(false)
        }
        const stop = (): void => {
            if (isRecording.getValue() || isCountingIn.getValue()) {return}
            finish()
        }
        // the engine's stop arrives without an animation frame, the flags only with one
        const stoppedAfterStart = ({kind, recording, contextTime}: TransportAnchor): boolean =>
            kind === "stop" && recording && engine.recordingStart.mapOr(start => contextTime >= start.contextTime, false)
        terminator.ownAll(
            engine.isRecording.subscribe(stop),
            engine.isCountingIn.subscribe(stop),
            engine.subscribeTransportAnchors(anchors => {if (anchors.some(stoppedAfterStart)) {finish()}}),
            Terminable.create(() => {
                this.#countIn = false
                this.#startPosition = 0.0
            })
        )
        this.#countIn = countIn && !engine.isPlaying.getValue()
        this.#startPosition = engine.position.getValue()
        return terminator
    }

    #setRecording(value: boolean): void {
        if (this.#isRecording === value) {return}
        this.#isRecording = value
        RecordingSession.#active += value ? 1 : -1
    }
}
