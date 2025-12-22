import {
    AnyClipBoxAdapter,
    ClipSequencing,
    ClipSequencingUpdates,
    Section,
    TrackBoxAdapter
} from "@opendaw/studio-adapters"
import {Arrays, identity, Option, quantizeFloor, SortedSet, UUID} from "@opendaw/lib-std"
import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {BoxGraph, Update} from "@opendaw/lib-box"

// Just convenient to identify which UUID is for which type
type ClipKey = UUID.Bytes
type TrackKey = UUID.Bytes

class TrackState {
    waiting: Option<Option<AnyClipBoxAdapter>> = Option.None
    playing: Option<AnyClipBoxAdapter> = Option.None

    constructor(readonly uuid: TrackKey) {}
}

export class ClipSequencingAudioContext implements ClipSequencing {
    readonly #boxGraph: BoxGraph
    readonly #states: SortedSet<TrackKey, TrackState>

    readonly #started: Array<ClipKey> = []
    readonly #stopped: Array<ClipKey> = []
    readonly #obsolete: Array<ClipKey> = []

    constructor(boxGraph: BoxGraph) {
        this.#boxGraph = boxGraph
        this.#boxGraph.subscribeToAllUpdatesImmediate({
            onUpdate: (update: Update) => {
                if (update.type === "delete") {
                    const uuid = update.uuid
                    // handle track deletion
                    this.#states.opt(uuid).ifSome(state => {
                        state.playing.ifSome(playing => this.#onStop(playing.uuid))
                        state.playing = Option.None
                        state.waiting = Option.None
                    })
                    // handle clip deletion
                    this.#states.forEach(state => {
                        if (state.playing.nonEmpty() && UUID.equals(state.playing.unwrap().uuid, uuid)) {
                            state.playing = Option.None
                            this.#onStop(uuid)
                        }
                        const optWaiting = state.waiting.flatMap(identity)
                        if (optWaiting.nonEmpty() && UUID.equals(optWaiting.unwrap().uuid, uuid)) {
                            state.waiting = Option.None
                        }
                    })
                }
            }
        })
        this.#states = UUID.newSet<TrackState>(state => state.uuid)
    }

    schedulePlay(clipAdapter: AnyClipBoxAdapter): void {
        clipAdapter.trackBoxAdapter.ifSome(({uuid}) => {
            const trackState = this.#states.getOrCreate(uuid, uuid => new TrackState(uuid))
            if (trackState.playing.nonEmpty() && trackState.playing.unwrap() === clipAdapter) {
                console.debug(`${clipAdapter} is already playing (ignore)`)
                return
            }
            const optClip = trackState.waiting.flatMap(waiting => waiting)
            if (optClip.nonEmpty()) {
                console.debug("obsolete", optClip.unwrap())
                this.#obsolete.push(optClip.unwrap().uuid)
                trackState.waiting = Option.None
            }
            console.debug(`schedulePlay(${UUID.toString(trackState.uuid)} > ${clipAdapter})`)
            Arrays.removeOpt(this.#obsolete, clipAdapter.uuid)
            trackState.waiting = Option.wrap(Option.wrap(clipAdapter))
        })
    }

    scheduleStop({uuid}: TrackBoxAdapter): void {
        const trackState = this.#states.getOrCreate(uuid, uuid => new TrackState(uuid))
        const optClip = trackState.waiting.flatMap(waiting => waiting)
        if (optClip.nonEmpty()) {
            console.debug("obsolete", optClip.unwrap())
            this.#obsolete.push(optClip.unwrap().uuid)
            trackState.waiting = Option.None
        }
        if (trackState.playing.nonEmpty()) {
            console.debug(`scheduleStop(${UUID.toString(uuid)})`)
            trackState.waiting = Option.wrap(Option.None)
        }
    }

    reset(): void {
        this.#states.forEach(state => {
            state.waiting.ifSome(waiting => waiting.ifSome(clip => this.#obsolete.push(clip.uuid)))
            state.waiting = Option.None
            state.playing.ifSome(clip => this.#onStop(clip.uuid))
            state.playing = Option.None
        })
        this.#states.clear()
    }

    * iterate(trackKey: TrackKey, p0: ppqn, p1: ppqn): IterableIterator<Section> {
        const state = this.#states.getOrNull(trackKey)
        if (state === null) {
            yield {optClip: Option.None, sectionFrom: p0, sectionTo: p1}
            return
        }
        if (state.waiting.nonEmpty()) {
            const optNextClip = state.waiting.unwrap()
            const scheduleDuration = state.playing.mapOr(clip => clip.duration, PPQN.Bar) // Use format values
            const scheduleEnd = quantizeFloor(p1, scheduleDuration)
            if (scheduleEnd >= p0) {
                if (p0 < scheduleEnd) {
                    // process to schedule time
                    yield {optClip: state.playing, sectionFrom: p0, sectionTo: scheduleEnd}
                }
                state.waiting = Option.None // clear the next pointer
                state.playing.ifSome(clip => this.#onStop(clip.uuid))
                if (optNextClip.nonEmpty()) {
                    state.playing = optNextClip // play next clip
                    this.#onStart(optNextClip.unwrap().uuid)
                } else {
                    state.playing = Option.None // stop playing clip
                }
                yield {optClip: state.playing, sectionFrom: scheduleEnd, sectionTo: p1}
            } else {
                yield {optClip: state.playing, sectionFrom: p0, sectionTo: p1}
            }
        } else {
            if (state.playing.nonEmpty()) {
                const playing = state.playing.unwrap()
                if (playing.box.triggerMode.loop.getValue()) {
                    yield {optClip: state.playing, sectionFrom: p0, sectionTo: p1}
                } else {
                    const scheduleEnd = quantizeFloor(p0, playing.duration) + playing.duration
                    if (scheduleEnd <= p1) {
                        yield {optClip: state.playing, sectionFrom: p0, sectionTo: scheduleEnd}
                        state.playing = Option.None
                        this.#onStop(playing.uuid)
                        if (scheduleEnd < p1) {
                            yield {optClip: Option.None, sectionFrom: scheduleEnd, sectionTo: p1}
                        }
                    } else {
                        yield {optClip: state.playing, sectionFrom: p0, sectionTo: p1}
                    }
                }
            } else {
                yield {optClip: Option.None, sectionFrom: p0, sectionTo: p1}
            }
        }
    }

    changes(): Option<ClipSequencingUpdates> {
        if (this.#started.length > 0 || this.#stopped.length > 0 || this.#obsolete.length > 0) {
            const changes = Option.wrap({
                started: this.#started.slice(),
                stopped: this.#stopped.slice(),
                obsolete: this.#obsolete.slice()
            })
            this.#started.length = 0
            this.#stopped.length = 0
            this.#obsolete.length = 0
            return changes
        }
        return Option.None
    }

    terminate(): void {
        this.#states.clear()
        this.#started.length = 0
        this.#stopped.length = 0
        this.#obsolete.length = 0
    }

    #onStart(clipKey: ClipKey): void {this.#started.push(clipKey)}
    #onStop(clipKey: ClipKey): void {this.#stopped.push(clipKey)}
}