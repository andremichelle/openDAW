import {Editing, EmptyExec, Errors, Exec, int, Maybe, Observer, Option, Subscription, SyncProvider, Terminable, Terminator, TimeSpan, UUID} from "@opendaw/lib-std"
import {Promises, Runtime} from "@opendaw/lib-runtime"
import {ppqn} from "@opendaw/lib-dsp"
import {TransportAnchor} from "@opendaw/studio-adapters"
import {Project} from "../project"
import type {LocalLayer} from "../ysync/YSync"
import {RecordAutomation} from "./RecordAutomation"
import {RoomTake} from "./RoomTake"

const PublishTimeout = TimeSpan.seconds(60)

// in a live room everything a recording writes stays on this client until the take is finished and its audio saved
class TakeScope implements Editing {
    readonly #editing: Editing

    #layer: Option<LocalLayer>
    #holds: int = 0
    #finished: boolean = false

    constructor(editing: Editing, layer: Option<LocalLayer>, readonly settle: Exec) {
        this.#editing = editing
        this.#layer = layer
    }

    #run<R>(procedure: SyncProvider<R>): R {return this.#layer.mapOr(layer => layer.run(procedure), procedure)}

    modify<R>(modifier: SyncProvider<Maybe<R>>, mark?: boolean): Option<R> {
        return this.#run(() => this.#editing.modify(modifier, mark))
    }
    append<R>(modifier: SyncProvider<Maybe<R>>): Option<R> {return this.#run(() => this.#editing.append(modifier))}
    mark(): void {this.#editing.mark()}
    canUndo(): boolean {return this.#editing.canUndo()}
    canRedo(): boolean {return this.#editing.canRedo()}
    undo(): boolean {return this.#editing.undo()}
    redo(): boolean {return this.#editing.redo()}
    markSaved(): void {this.#editing.markSaved()}
    hasUnsavedChanges(): boolean {return this.#editing.hasUnsavedChanges()}
    hasNoChanges(): boolean {return this.#editing.hasNoChanges()}
    revertPending(): void {this.#editing.revertPending()}
    subscribe(observer: Observer<void>): Subscription {return this.#editing.subscribe(observer)}

    hold(): Exec {
        if (this.#layer.isEmpty()) {return EmptyExec}
        this.#holds++
        let released = false
        return () => {
            if (released) {return}
            released = true
            this.#holds--
            this.#publishIfReady()
        }
    }

    finish(): void {
        this.#finished = true
        this.#publishIfReady()
        if (this.#layer.nonEmpty()) {Runtime.scheduleTimeout(() => this.#publish(), PublishTimeout.millis())}
    }

    #publishIfReady(): void {if (this.#finished && this.#holds === 0) {this.#publish()}}

    #publish(): void {
        this.#layer.ifSome(layer => {
            this.settle()
            layer.publish()
            layer.terminate()
        })
        this.#layer = Option.None
    }
}

// one recording at a time per project: arms the captures, drives the engine, finalizes on the engine's stop
export class RecordingSession {
    static #active: number = 0

    // any project records
    static get anyRecording(): boolean {return this.#active > 0}

    readonly #project: Project

    #take: Option<TakeScope> = Option.None
    #isRecording: boolean = false
    #countIn: boolean = false
    #startPosition: ppqn = 0.0

    constructor(project: Project) {this.#project = project}

    get isRecording(): boolean {return this.#isRecording}
    get wasCountingIn(): boolean {return this.#countIn}
    get startPosition(): ppqn {return this.#startPosition}

    // what recorders write through, outside a live room this is the project's editing
    get editing(): Editing {return this.#take.mapOr<Editing>(take => take, this.#project.editing)}

    // the take reaches the room only after every hold is released
    holdPublish(): Exec {return this.#take.match({none: () => EmptyExec, some: take => take.hold()})}

    async start(countIn: boolean): Promise<Terminable> {
        if (this.#isRecording) {return Terminable.Empty}
        this.#setRecording(true)
        const project = this.#project
        const {captureDevices, engine} = project
        const terminator = new Terminator()
        const captures = captureDevices.filterArmed()
        const layer = project.liveSync.map(sync => sync.createLayer("take"))
        const take = new TakeScope(project.editing, layer, () => layer.ifSome(layer => RoomTake.settle(project, layer)))
        this.#take = Option.wrap(take)
        if (captures.length > 0) {
            const {status, error} =
                await Promises.tryCatch(Promise.all(captures.map(capture => capture.prepareRecording())))
            if (status === "rejected") {
                layer.ifSome(layer => layer.terminate())
                this.#take = Option.None
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
            take.modify(() => terminator.terminate(), false) // finalizes recording
            take.mark() // every take is its own undo step
            this.#setRecording(false)
            take.finish()
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
