import {bpm, ppqn, PPQN, RenderQuantum} from "@opendaw/lib-dsp"
import {Block, BlockFlags, ProcessInfo} from "./processing"
import {EngineContext} from "./EngineContext"
import {
    Exec,
    int,
    isDefined,
    Iterables,
    Nullable,
    Option,
    Procedure,
    quantizeCeil,
    SetMultimap,
    Terminable,
    Terminator
} from "@opendaw/lib-std"
import {MarkerBoxAdapter, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"

const TEMPO_CHANGE_GRID = PPQN.fromSignature(1, 48) // make dynamic window 10ms

type Action = null
    | { type: "loop", target: ppqn }
    | { type: "marker", prev: MarkerBoxAdapter, next: MarkerBoxAdapter }
    | { type: "callback", position: ppqn, callbacks: ReadonlySet<Exec> }
    | { type: "tempo", position: ppqn, bpm: bpm }

export class BlockRenderer implements Terminable {
    readonly #terminator = new Terminator()
    readonly #context: EngineContext

    readonly #callbacks: SetMultimap<ppqn, Exec>
    readonly #pauseOnLoopDisabled: boolean = true

    #bpmChanged: boolean = false
    #currentMarker: Nullable<[MarkerBoxAdapter, int]> = null
    #someMarkersChanged: boolean = false
    #freeRunningPosition: ppqn = 0.0 // synced with timeInfo when transporting
    #optTempoTrack: Option<ValueEventCollectionBoxAdapter> = Option.None
    #bpm: bpm

    constructor(context: EngineContext, options?: { pauseOnLoopDisabled?: boolean }) {
        this.#context = context
        const {timelineBoxAdapter: {box: {bpm}, markerTrack, tempoTrack}} = context
        this.#bpm = bpm.getValue()
        markerTrack.subscribe(() => this.#someMarkersChanged = true)
        this.#terminator.ownAll(
            bpm.subscribe((owner) => {
                if (this.#optTempoTrack.isEmpty()) {
                    this.#bpm = owner.getValue()
                    this.#bpmChanged = true
                }
            }),
            tempoTrack.catchupAndSubscribe(option => {
                this.#optTempoTrack = option
                if (option.isEmpty()) {
                    this.#bpm = bpm.getValue()
                    this.#bpmChanged = true
                }
            })
        )

        this.#pauseOnLoopDisabled = options?.pauseOnLoopDisabled ?? false
        this.#callbacks = new SetMultimap()
    }

    get bpm(): bpm {return this.#bpm}

    setCallback(position: ppqn, callback: Exec): Terminable {
        this.#callbacks.add(position, callback)
        return Terminable.create(() => this.#callbacks.remove(position, callback))
    }

    reset(): void {
        this.#bpmChanged = false
        this.#someMarkersChanged = false
        this.#freeRunningPosition = 0.0
        this.#currentMarker = null
    }

    process(procedure: Procedure<ProcessInfo>): void {
        let markerChanged = false

        const {timeInfo, timelineBoxAdapter: {box: timelineBox, markerTrack}} = this.#context
        const transporting = timeInfo.transporting
        if (transporting) {
            const blocks: Array<Block> = []
            let p0 = timeInfo.position
            let s0: int = 0 | 0
            let index: int = 0 | 0
            let discontinuous = timeInfo.getLeapStateAndReset()
            while (s0 < RenderQuantum) {
                if (this.#someMarkersChanged || discontinuous) {
                    this.#someMarkersChanged = false
                    const marker = markerTrack.events.lowerEqual(p0)
                    if ((this.#currentMarker?.at(0) ?? null) !== marker) {
                        this.#currentMarker = isDefined(marker) ? [marker, 0] : null
                        markerChanged = true
                    }
                }
                if (discontinuous && this.#optTempoTrack.nonEmpty()) {
                    const newBpm = this.#optTempoTrack.unwrap().valueAt(p0, this.#bpm)
                    if (newBpm !== this.#bpm) {
                        this.#bpm = newBpm
                        this.#bpmChanged = true
                    }
                }
                const sn: int = RenderQuantum - s0
                const p1 = p0 + PPQN.samplesToPulses(sn, this.#bpm, sampleRate)
                let action: Action = null
                let actionPosition: ppqn = Number.POSITIVE_INFINITY

                //
                // evaluate nearest global action
                //

                // --- MARKER ---
                if (markerTrack.enabled) {
                    const markers = Array.from(Iterables.take(markerTrack.events.iterateFrom(p0), 2))
                    if (markers.length > 0) {
                        const [prev, next] = markers
                        // This branch happens if all markers are in the future
                        if (this.#currentMarker === null) {
                            if (prev.position >= p0 && prev.position < p1) {
                                action = {type: "marker", prev, next}
                                actionPosition = prev.position
                            }
                        } else if (
                            isDefined(next)
                            && next !== this.#currentMarker[0] // must be different from the current
                            && prev.position < p0 // must be in the past
                            && next.position < p1 // must be inside the block
                        ) {
                            action = {type: "marker", prev, next}
                            actionPosition = next.position
                        }
                    }
                }
                // --- LOOP SECTION ---
                const {isRecording, isCountingIn} = this.#context.timeInfo // TODO We need a concept for loops in recording
                const {from, to, enabled} = timelineBox.loopArea
                const loopEnabled = enabled.getValue()
                if ((loopEnabled && !(isRecording || isCountingIn)) || this.#pauseOnLoopDisabled) {
                    const loopTo = to.getValue()
                    if (p0 < loopTo && p1 > loopTo && loopTo < actionPosition) {
                        action = {type: "loop", target: from.getValue()}
                        actionPosition = loopTo
                    }
                }
                // --- ARM PLAYING ---
                if (this.#callbacks.keyCount() > 0) {
                    for (const position of this.#callbacks.keys()) {
                        if (p0 < position && p1 > position && position < actionPosition) {
                            action = {type: "callback", position, callbacks: this.#callbacks.get(position)}
                            actionPosition = position
                        }
                    }
                }
                // --- TEMPO AUTOMATION ---
                if (this.#optTempoTrack.nonEmpty()) {
                    if (!this.#optTempoTrack.unwrap().events.isEmpty()) {
                        const nextGrid: ppqn = quantizeCeil(p0, TEMPO_CHANGE_GRID)
                        if (nextGrid >= p0 && nextGrid < p1 && nextGrid < actionPosition) {
                            const tempoAtGrid = this.#optTempoTrack.unwrap().valueAt(nextGrid, this.#bpm)
                            if (tempoAtGrid !== this.#bpm) {
                                action = {type: "tempo", position: nextGrid, bpm: tempoAtGrid}
                                actionPosition = nextGrid
                            }
                        }
                    }
                }
                //
                // handle action (if any)
                //
                const playing = !timeInfo.isCountingIn
                if (action === null) {
                    const s1 = s0 + sn
                    blocks.push({
                        index: index++, p0, p1, s0, s1, bpm: this.#bpm,
                        flags: BlockFlags.create(transporting, discontinuous, playing, this.#bpmChanged)
                    })
                    discontinuous = false
                    p0 = p1
                    s0 = s1
                } else {
                    const advanceToEvent = () => {
                        if (actionPosition > p0) {
                            const s1 = s0 + PPQN.pulsesToSamples(actionPosition - p0, this.#bpm, sampleRate) | 0
                            if (s1 > s0) {
                                blocks.push({
                                    index: index++, p0, p1: actionPosition, s0, s1, bpm: this.#bpm,
                                    flags: BlockFlags.create(transporting, discontinuous, playing, this.#bpmChanged)
                                })
                                discontinuous = false
                            }
                            p0 = actionPosition
                            s0 = s1
                        }
                    }
                    const releaseBlock = () => {
                        if (s0 < RenderQuantum) {
                            const s1 = s0 + PPQN.pulsesToSamples(p1 - p0, this.#bpm, sampleRate) | 0
                            blocks.push({
                                index: index++, p0, p1: actionPosition, s0, s1, bpm: this.#bpm,
                                flags: BlockFlags.create(false, false, false, this.#bpmChanged)
                            })
                            s0 = s1
                        }
                    }
                    switch (action.type) {
                        case "loop": {
                            advanceToEvent()
                            if (this.#pauseOnLoopDisabled) {
                                this.#context.timeInfo.pause()
                                releaseBlock()
                            } else {
                                p0 = action.target
                                discontinuous = true
                            }
                            break
                        }
                        case "marker": {
                            const {prev, next} = action
                            if (!isDefined(this.#currentMarker) || this.#currentMarker[0] !== prev) {
                                this.#currentMarker = [prev, 0]
                            } else {
                                if (++this.#currentMarker[1] < prev.plays || prev.plays === 0) {
                                    advanceToEvent()
                                    p0 = prev.position
                                    discontinuous = true
                                } else {
                                    this.#currentMarker = [next, 0]
                                }
                            }
                            markerChanged = true
                            break
                        }
                        case "callback": {
                            advanceToEvent()
                            action.callbacks.forEach(callback => callback())
                            break
                        }
                        case "tempo": {
                            advanceToEvent()
                            this.#bpm = action.bpm
                            this.#bpmChanged = true
                            break
                        }
                    }
                }
            }
            procedure({blocks})
            timeInfo.advanceTo(p0)
            discontinuous = false
            this.#freeRunningPosition = p0
            this.#bpmChanged = false
        } else {
            const discontinuous = timeInfo.getLeapStateAndReset()
            if (discontinuous && this.#optTempoTrack.nonEmpty()) {
                const newBpm = this.#optTempoTrack.unwrap().valueAt(this.#context.timeInfo.position, this.#bpm)
                if (newBpm !== this.#bpm) {
                    this.#bpm = newBpm
                    this.#bpmChanged = true
                }
            }
            if (this.#someMarkersChanged || discontinuous) {
                this.#someMarkersChanged = false
                const marker = markerTrack.events.lowerEqual(timeInfo.position)
                if (marker !== null) {
                    if (this.#currentMarker?.at(0) !== marker) {
                        this.#currentMarker = [marker, 0]
                        markerChanged = true
                    }
                }
            }
            const p0 = this.#freeRunningPosition
            const p1 = p0 + PPQN.samplesToPulses(RenderQuantum, this.#bpm, sampleRate)
            const processInfo: ProcessInfo = {
                blocks: [{
                    index: 0, p0, p1, s0: 0, s1: RenderQuantum, bpm: this.#bpm,
                    flags: BlockFlags.create(false, false, false, this.#bpmChanged)
                }]
            }
            procedure(processInfo)
            this.#bpmChanged = false
            this.#freeRunningPosition = p1
        }
        if (markerChanged) {
            this.#context.engineToClient.switchMarkerState(isDefined(this.#currentMarker)
                ? [this.#currentMarker[0].uuid, this.#currentMarker[1]] : null)
        }
    }

    terminate(): void {this.#terminator.terminate()}
}