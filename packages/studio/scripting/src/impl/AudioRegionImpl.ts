import {AudioPlayback, AudioRegion, AudioTrack} from "../Api"
import {PPQN, ppqn} from "@moises-ai/lib-dsp"
import {int} from "@moises-ai/lib-std"
import {ColorCodes, Sample, TrackType} from "@moises-ai/studio-adapters"

export class AudioRegionImpl implements AudioRegion {
    readonly track: AudioTrack

    sample: Sample
    playback: AudioPlayback

    position: ppqn
    duration: ppqn
    mute: boolean
    label: string
    hue: int
    loopDuration: ppqn
    loopOffset: ppqn

    constructor(track: AudioTrack, sample: Sample, props?: Partial<AudioRegion>) {
        this.track = track
        this.sample = sample
        this.playback = props?.playback ?? AudioPlayback.PitchStretch
        this.position = props?.position ?? 0.0
        this.duration = props?.duration ?? PPQN.Bar
        this.loopDuration = props?.loopDuration ?? this.duration
        this.loopOffset = props?.loopOffset ?? 0.0
        this.mute = props?.mute ?? false
        this.label = props?.label ?? ""
        this.hue = props?.hue ?? ColorCodes.forTrackType(TrackType.Audio)
    }
}
