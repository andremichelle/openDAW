import {
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioSignalsmithBox,
    AudioTimeStretchBox,
    WarpMarkerBox
} from "@opendaw/studio-boxes"
import {Box} from "@opendaw/lib-box"
import {PPQN, ppqn, seconds, TimeBase} from "@opendaw/lib-dsp"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {asInstanceOf, Class, float, isDefined, isInstanceOf, Nullable, panic, quantizeRound, UUID} from "@opendaw/lib-std"
import {AudioPlayback, Sample} from "../../Api"
import {Context} from "../Context"
import {Guard} from "../Guard"
import {AudioFiles} from "../AudioFiles"

export type AudioContentBox = AudioRegionBox | AudioClipBox
export type PlayModeBox = AudioPitchStretchBox | AudioTimeStretchBox | AudioSignalsmithBox

export namespace AudioContents {
    export const Playbacks: ReadonlyArray<AudioPlayback> = ["no-sync", "pitch", "timestretch", "signalsmith"]

    export const playModeBox = (box: AudioContentBox): Nullable<PlayModeBox> =>
        box.playMode.targetVertex.mapOr(vertex => vertex.box as PlayModeBox, null)

    export const playback = (box: AudioContentBox): AudioPlayback => {
        if (box.timeBase.getValue() === TimeBase.Seconds) {return "no-sync"}
        const playMode = playModeBox(box)
        if (playMode instanceof AudioPitchStretchBox) {return "pitch"}
        if (playMode instanceof AudioTimeStretchBox) {return "timestretch"}
        if (playMode instanceof AudioSignalsmithBox) {return "signalsmith"}
        return "no-sync"
    }

    export const sample = (context: Context, box: AudioContentBox): Sample =>
        AudioFiles.toSample(context, asInstanceOf(box.file.targetVertex.unwrap("audio content has no file").box, AudioFileBox))

    export const defaultPlayback = (sample: Sample): AudioPlayback => sample.bpm > 0 ? "pitch" : "no-sync"

    export const defaultDuration = (sample: Sample, playback: AudioPlayback, projectBpm: number): number => {
        if (playback === "no-sync") {return sample.duration}
        const pulses = PPQN.secondsToPulses(sample.duration, sample.bpm > 0 ? sample.bpm : projectBpm)
        return pulses < PPQN.SemiQuaver ? pulses : quantizeRound(pulses, PPQN.SemiQuaver)
    }

    export const validatePlayback = (value: unknown): AudioPlayback => Guard.oneOf(value, Playbacks, "playback")

    export type PlayModeProps = { transientPlayMode?: TransientPlayMode, playbackRate?: float, transpose?: float }

    export const createPlayMode = (context: Context,
                                   playback: AudioPlayback,
                                   durationInPPQN: ppqn,
                                   durationInSeconds: seconds,
                                   props: PlayModeProps): Nullable<PlayModeBox> => {
        const boxGraph = context.boxGraph
        if (playback === "no-sync") {return null}
        const playMode: PlayModeBox = playback === "pitch"
            ? AudioPitchStretchBox.create(boxGraph, UUID.generate())
            : playback === "timestretch"
                ? AudioTimeStretchBox.create(boxGraph, UUID.generate(), box => {
                    box.transientPlayMode.setValue(props.transientPlayMode ?? TransientPlayMode.Pingpong)
                    box.playbackRate.setValue(props.playbackRate ?? 1.0)
                })
                : AudioSignalsmithBox.create(boxGraph, UUID.generate(), box => {
                    box.transpose.setValue(props.transpose ?? 0.0)
                })
        if (durationInPPQN <= 0 || durationInSeconds <= 0) {
            return panic(new RangeError(`Audio content requires positive durations (ppqn: ${durationInPPQN}, seconds: ${durationInSeconds})`))
        }
        WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(playMode.warpMarkers)
            box.position.setValue(0)
            box.seconds.setValue(0.0)
        })
        WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
            box.owner.refer(playMode.warpMarkers)
            box.position.setValue(durationInPPQN)
            box.seconds.setValue(durationInSeconds)
        })
        return playMode
    }

    export const transientPlayMode = (box: AudioContentBox): TransientPlayMode => {
        const playMode = playModeBox(box)
        return playMode instanceof AudioTimeStretchBox ? playMode.transientPlayMode.getValue() : TransientPlayMode.Pingpong
    }

    export const setTransientPlayMode = (context: Context, box: AudioContentBox, value: TransientPlayMode): void => {
        const playMode = requirePlayMode(box, AudioTimeStretchBox, "transientPlayMode", "timestretch")
        const validated = Guard.oneOf(value, [TransientPlayMode.Once, TransientPlayMode.Repeat, TransientPlayMode.Pingpong], "transientPlayMode")
        context.edit(() => playMode.transientPlayMode.setValue(validated))
    }

    export const playbackRate = (box: AudioContentBox): float => {
        const playMode = playModeBox(box)
        return playMode instanceof AudioTimeStretchBox ? playMode.playbackRate.getValue() : 1.0
    }

    export const setPlaybackRate = (context: Context, box: AudioContentBox, value: float): void => {
        const playMode = requirePlayMode(box, AudioTimeStretchBox, "playbackRate", "timestretch")
        const validated = Guard.float32("positive", value, "playbackRate")
        context.edit(() => playMode.playbackRate.setValue(validated))
    }

    export const transpose = (box: AudioContentBox): float => {
        const playMode = playModeBox(box)
        return playMode instanceof AudioSignalsmithBox ? playMode.transpose.getValue() : 0.0
    }

    export const setTranspose = (context: Context, box: AudioContentBox, value: float): void => {
        const playMode = requirePlayMode(box, AudioSignalsmithBox, "transpose", "signalsmith")
        const validated = Guard.float32({min: -24.0, max: 24.0, scaling: "linear"}, value, "transpose")
        context.edit(() => playMode.transpose.setValue(validated))
    }

    const requirePlayMode = <B extends Box>(box: AudioContentBox, type: Class<B>, name: string, playback: AudioPlayback): B => {
        const playMode = playModeBox(box)
        if (isDefined(playMode) && isInstanceOf(playMode, type)) {return playMode}
        return panic(new RangeError(`${name} is only available for playback "${playback}", this content plays "${AudioContents.playback(box)}"`))
    }
}
