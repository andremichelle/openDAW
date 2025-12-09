import {ppqn, PPQN, TimeBase} from "@opendaw/lib-dsp"
import {ColorCodes, Sample, TrackType} from "@opendaw/studio-adapters"
import {int, isDefined, panic, quantizeRound, UUID} from "@opendaw/lib-std"
import {
    AudioClipBox,
    AudioFileBox,
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioTimeStretchBox,
    TrackBox,
    ValueEventCollectionBox
} from "@opendaw/studio-boxes"
import {TransientPlayMode} from "@opendaw/studio-enums"
import {BoxGraph} from "@opendaw/lib-box"
import {AudioContentHelpers} from "./AudioContentHelpers"
import {WarpMarkerTemplate} from "./WarpMarkerTemplate"

export namespace AudioContentFactory {
    export type Props = {
        boxGraph: BoxGraph,
        targetTrack: TrackBox,
        audioFileBox: AudioFileBox,
        sample: Sample
        warpMarkers?: ReadonlyArray<WarpMarkerTemplate>
        waveformOffset?: number
        gainInDb?: number
    }

    export type Clip = Props & { index: int }
    export type Region = Props & { position: ppqn, duration?: ppqn, name?: string }

    export type TimeStretchedProps = {
        transientPlayMode?: TransientPlayMode
        playbackRate?: number
    } & Props

    export type PitchStretchedProps = { /* Has no additional properties yet */ } & Props

    export type NotStretchedProps = { /* Has no additional properties yet */ } & Props

    // --- Region Creation --- //

    export const createTimeStretchedRegion = (props: TimeStretchedProps & Region): AudioRegionBox => {
        const {boxGraph, playbackRate, transientPlayMode} = props
        return createRegionWithWarpMarkers(AudioTimeStretchBox.create(boxGraph, UUID.generate(), box => {
            box.transientPlayMode.setValue(transientPlayMode ?? TransientPlayMode.Pingpong)
            box.playbackRate.setValue(playbackRate ?? 1.0)
        }), props)
    }

    export const createPitchStretchedRegion = (props: PitchStretchedProps & Region): AudioRegionBox => {
        return createRegionWithWarpMarkers(AudioPitchStretchBox.create(props.boxGraph, UUID.generate()), props)
    }

    export const createNotStretchedRegion = (props: NotStretchedProps & Region): AudioRegionBox => {
        const {boxGraph, targetTrack, position, audioFileBox, sample: {name, duration: durationInSeconds}} = props
        const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(durationInSeconds)
            box.loopDuration.setValue(durationInSeconds)
            box.regions.refer(targetTrack.regions)
            box.hue.setValue(ColorCodes.forTrackType(targetTrack.type.getValue()))
            box.label.setValue(props.name ?? name)
            box.file.refer(audioFileBox)
            box.events.refer(collectionBox.owners)
            box.timeBase.setValue(TimeBase.Seconds)
            box.gain.setValue(props.gainInDb ?? 0.0)
            box.waveformOffset.setValue(props.waveformOffset ?? 0.0)
        })
    }

    // --- Clip Creation --- //

    export const createTimeStretchedClip = (props: TimeStretchedProps & Clip): AudioClipBox => {
        const {boxGraph, playbackRate, transientPlayMode} = props
        return createClipWithWarpMarkers(AudioTimeStretchBox.create(boxGraph, UUID.generate(), box => {
            box.transientPlayMode.setValue(transientPlayMode ?? TransientPlayMode.Pingpong)
            box.playbackRate.setValue(playbackRate ?? 1.0)
        }), props)
    }

    export const createPitchStretchedClip = (props: PitchStretchedProps & Clip): AudioClipBox => {
        const {boxGraph} = props
        return createClipWithWarpMarkers(AudioTimeStretchBox.create(boxGraph, UUID.generate()), props)
    }

    export const createNotStretchedClip = (props: NotStretchedProps & Clip): AudioClipBox => {
        const {boxGraph, targetTrack, index, audioFileBox, sample: {name, duration: durationInSeconds}} = props
        const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return AudioClipBox.create(boxGraph, UUID.generate(), box => {
            box.duration.setValue(durationInSeconds)
            box.clips.refer(targetTrack.clips)
            box.hue.setValue(ColorCodes.forTrackType(targetTrack.type.getValue()))
            box.waveformOffset.setValue(props.waveformOffset ?? 0.0)
            box.label.setValue(name)
            box.file.refer(audioFileBox)
            box.events.refer(collectionBox.owners)
            box.timeBase.setValue(TimeBase.Seconds)
            box.index.setValue(index)
        })
    }

    // ---- HELPERS ---- //

    const createRegionWithWarpMarkers = (playMode: AudioPitchStretchBox | AudioTimeStretchBox,
                                         props: (TimeStretchedProps | PitchStretchedProps) & Region): AudioRegionBox => {
        const {boxGraph, targetTrack, position, audioFileBox, sample} = props
        if (targetTrack.type.getValue() !== TrackType.Audio) {
            return panic("Cannot create audio-region on non-audio track")
        }
        const {name, duration: durationInSeconds, bpm} = sample
        const durationInPPQN = quantizeRound(PPQN.secondsToPulses(durationInSeconds, bpm), PPQN.SemiQuaver)
        if (isDefined(props.warpMarkers)) {
            AudioContentHelpers.addWarpMarkers(boxGraph, playMode, props.warpMarkers)
        } else {
            AudioContentHelpers.addDefaultWarpMarkers(boxGraph, playMode, durationInPPQN, durationInSeconds)
        }
        const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return AudioRegionBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(props.duration ?? durationInPPQN)
            box.loopDuration.setValue(props.duration ?? durationInPPQN)
            box.regions.refer(targetTrack.regions)
            box.waveformOffset.setValue(props.waveformOffset ?? 0.0)
            box.hue.setValue(ColorCodes.forTrackType(targetTrack.type.getValue()))
            box.label.setValue(name)
            box.file.refer(audioFileBox)
            box.events.refer(collectionBox.owners)
            box.timeBase.setValue(TimeBase.Musical)
            box.playMode.refer(playMode)
            box.gain.setValue(props.gainInDb ?? 0.0)
        })
    }

    const createClipWithWarpMarkers = (playMode: AudioPitchStretchBox | AudioTimeStretchBox,
                                       props: (TimeStretchedProps | PitchStretchedProps) & Clip): AudioClipBox => {
        const {boxGraph, targetTrack, audioFileBox, sample} = props
        if (targetTrack.type.getValue() !== TrackType.Audio) {
            return panic("Cannot create audio-region on non-audio track")
        }
        const {name, duration: durationInSeconds, bpm} = sample
        const durationInPPQN = quantizeRound(PPQN.secondsToPulses(durationInSeconds, bpm), PPQN.SemiQuaver)
        if (isDefined(props.warpMarkers)) {
            AudioContentHelpers.addWarpMarkers(boxGraph, playMode, props.warpMarkers)
        } else {
            AudioContentHelpers.addDefaultWarpMarkers(boxGraph, playMode, durationInPPQN, durationInSeconds)
        }
        const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        return AudioClipBox.create(boxGraph, UUID.generate(), box => {
            box.duration.setValue(durationInPPQN)
            box.clips.refer(targetTrack.clips)
            box.hue.setValue(ColorCodes.forTrackType(targetTrack.type.getValue()))
            box.waveformOffset.setValue(props.waveformOffset ?? 0.0)
            box.label.setValue(name)
            box.file.refer(audioFileBox)
            box.events.refer(collectionBox.owners)
            box.timeBase.setValue(TimeBase.Musical)
            box.playMode.refer(playMode)
            box.index.setValue(props.index)
        })
    }
}