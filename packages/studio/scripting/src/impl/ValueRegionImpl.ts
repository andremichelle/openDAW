import {ValueEvent, ValueRegion, ValueRegionProps, ValueTrack} from "../Api"
import {ppqn} from "@moises-ai/lib-dsp"
import {int} from "@moises-ai/lib-std"
import {ValueEventImpl} from "./ValueEventImpl"
import {ColorCodes, TrackType} from "@moises-ai/studio-adapters"
import {Wait} from "@moises-ai/lib-runtime"

export class ValueRegionImpl implements ValueRegion {
    readonly track: ValueTrack
    readonly #events: Array<ValueEventImpl>

    readonly mirror?: ValueRegion

    position: ppqn
    duration: ppqn
    loopDuration: ppqn
    loopOffset: ppqn
    mute: boolean
    label: string
    hue: int

    constructor(track: ValueTrack, props?: ValueRegionProps) {
        this.track = track
        this.mirror = props?.mirror
        this.position = props?.position ?? 0.0
        this.duration = props?.duration ?? 0.0
        this.mute = props?.mute ?? false
        this.label = props?.label ?? ""
        this.hue = props?.hue ?? ColorCodes.forTrackType(TrackType.Value)
        this.loopDuration = props?.loopDuration ?? this.duration
        this.loopOffset = props?.loopOffset ?? 0.0
        this.#events = []
    }

    addEvent(props?: Partial<ValueEvent>): ValueEvent {
        const event = new ValueEventImpl(props)
        this.#events.push(event)
        return event
    }

    addEvents(events: Array<Partial<ValueEvent>>): void {
        events.forEach(event => this.addEvent(event))
    }

    get events(): ReadonlyArray<ValueEventImpl> {
        return this.#events
    }
}