import {bpm, ppqn, PPQN, RenderQuantum} from "@opendaw/lib-dsp"
import {Block, BlockFlags, ProcessInfo} from "./processing"
import {EngineContext} from "./EngineContext"
import {
    Exec,
    int,
    isDefined,
    Iterables,
    Nullable,
    Procedure,
    quantizeCeil,
    SetMultimap,
    Terminable
} from "@opendaw/lib-std"
import {MarkerBoxAdapter, ValueEventCollectionBoxAdapter} from "@opendaw/studio-adapters"

const TEMPO_CHANGE_GRID = PPQN.fromSignature(1, 16)

type Action = null
    | { type: "loop", target: ppqn }
    | { type: "marker", prev: MarkerBoxAdapter, next: MarkerBoxAdapter }
    | { type: "callback", position: ppqn, callbacks: ReadonlySet<Exec> }
    | { type: "tempo", position: ppqn, bpm: bpm }

export class BlockRenderer {
    readonly #context: EngineContext

    readonly #callbacks: SetMultimap<ppqn, Exec>
    readonly #pauseOnLoopDisabled: boolean = true

    #tempoChanged: boolean = false
    #currentMarker: Nullable<[MarkerBoxAdapter, int]> = null
    #someMarkersChanged: boolean = false
    #freeRunningPosition: ppqn = 0.0 // synced with timeInfo when transporting
    #tempoTrack: Nullable<ValueEventCollectionBoxAdapter> = null
    #bpm: bpm

    constructor(context: EngineContext, options?: { pauseOnLoopDisabled?: boolean }) {
        this.#context = context
        this.#bpm = this.#context.timelineBoxAdapter.box.bpm.getValue()
        this.#context.timelineBoxAdapter.markerTrack.subscribe(() => this.#someMarkersChanged = true)
        this.#context.timelineBoxAdapter.box.bpm.subscribe(({getValue}) => {
            // Only update from storage if there's no tempo automation
            if (this.#tempoTrack === null) {
                this.#bpm = getValue()
            }
            this.#tempoChanged = true
        })
        this.#context.timelineBoxAdapter.tempoTrack.catchupAndSubscribe(option => {
            this.#tempoTrack = option.unwrapOrNull()
            this.#tempoChanged = true
        })
        this.#pauseOnLoopDisabled = options?.pauseOnLoopDisabled ?? false

        this.#callbacks = new SetMultimap()
    }

    get bpm(): bpm {return this.#bpm}

    setCallback(position: ppqn, callback: Exec): Terminable {
        this.#callbacks.add(position, callback)
        return Terminable.create(() => this.#callbacks.remove(position, callback))
    }

    reset(): void {
        this.#tempoChanged = false
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
                if (this.#tempoTrack !== null && !this.#tempoTrack.events.isEmpty()) {
                    const nextBoundary: ppqn = quantizeCeil(p0, TEMPO_CHANGE_GRID)
                    if (nextBoundary > p0 && nextBoundary < p1 && nextBoundary < actionPosition) {
                        const tempoAtBoundary = this.#tempoTrack.valueAt(nextBoundary, this.#bpm)
                        if (tempoAtBoundary !== this.#bpm) {
                            action = {type: "tempo", position: nextBoundary, bpm: tempoAtBoundary}
                            actionPosition = nextBoundary
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
                        flags: BlockFlags.create(transporting, discontinuous, playing, this.#tempoChanged)
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
                                    flags: BlockFlags.create(transporting, discontinuous, playing, this.#tempoChanged)
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
                                flags: BlockFlags.create(false, false, false, this.#tempoChanged)
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
                            break
                        }
                    }
                }
                this.#tempoChanged = false
            }
            procedure({blocks})
            timeInfo.advanceTo(p0)
            this.#freeRunningPosition = p0
        } else {
            if (this.#someMarkersChanged || timeInfo.getLeapStateAndReset()) {
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
                    flags: BlockFlags.create(false, false, false, false)
                }]
            }
            procedure(processInfo)
            this.#freeRunningPosition = p1
        }
        if (markerChanged) {
            this.#context.engineToClient.switchMarkerState(isDefined(this.#currentMarker)
                ? [this.#currentMarker[0].uuid, this.#currentMarker[1]] : null)
        }
    }
}