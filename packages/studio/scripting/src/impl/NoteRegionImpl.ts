import {NoteEvent, NoteRegion, NoteRegionProps, NoteTrack} from "../Api"
import {PPQN, ppqn} from "@moises-ai/lib-dsp"
import {int} from "@moises-ai/lib-std"
import {NoteEventImpl} from "./NoteEventImpl"
import {ColorCodes, TrackType} from "@moises-ai/studio-adapters"

export class NoteRegionImpl implements NoteRegion {
    readonly track: NoteTrack
    readonly #events: Array<NoteEventImpl>
    readonly mirror?: NoteRegion

    position: ppqn
    duration: ppqn
    mute: boolean
    label: string
    hue: int
    loopDuration: ppqn
    loopOffset: ppqn

    constructor(track: NoteTrack, props?: NoteRegionProps) {
        this.track = track
        this.position = props?.position ?? 0.0
        this.duration = props?.duration ?? PPQN.Bar
        this.loopDuration = props?.loopDuration ?? this.duration
        this.loopOffset = props?.loopOffset ?? 0.0
        this.mute = props?.mute ?? false
        this.label = props?.label ?? ""
        this.hue = props?.hue ?? ColorCodes.forTrackType(TrackType.Notes)
        this.mirror = props?.mirror
        this.#events = []
    }

    addEvent(props?: Partial<NoteEvent>): NoteEvent {
        const event = new NoteEventImpl(props)
        this.#events.push(event)
        return event
    }

    addEvents(events: Array<Partial<NoteEvent>>): void {
        events.forEach(event => this.addEvent(event))
    }

    get events(): ReadonlyArray<NoteEventImpl> {return this.#events}
}
