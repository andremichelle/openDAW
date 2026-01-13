import {UUID} from "@moises-ai/lib-std"
import {
    AudioPitchStretchBox,
    AudioRegionBox,
    AudioUnitBox,
    TrackBox,
    ValueEventCollectionBox,
    WarpMarkerBox
} from "@moises-ai/studio-boxes"
import {TrackType} from "@moises-ai/studio-adapters"
import {BoxGraph} from "@moises-ai/lib-box"
import {IndexRef} from "./IndexRef"
import {AudioPlayback} from "./Api"
import {AudioTrackImpl} from "./impl/AudioTrackImpl"
import {AudioRegionImpl} from "./impl/AudioRegionImpl"
import {TimeBase} from "@moises-ai/lib-dsp"
import {AudioFileBoxfactory} from "./AudioFileBoxfactory"

export namespace AudioTrackWriter {
    export const write = (boxGraph: BoxGraph,
                          audioUnitBox: AudioUnitBox,
                          audioTracks: ReadonlyArray<AudioTrackImpl>,
                          indexRef: IndexRef): void => {
        audioTracks.forEach(({enabled, regions}: AudioTrackImpl) => {
            const trackBox = TrackBox.create(boxGraph, UUID.generate(), box => {
                box.type.setValue(TrackType.Audio)
                box.enabled.setValue(enabled)
                box.index.setValue(indexRef.index++)
                box.target.refer(audioUnitBox)
                box.tracks.refer(audioUnitBox.tracks)
            })
            regions.forEach((region: AudioRegionImpl) => {
                const {
                    position, duration, loopDuration, loopOffset, hue, label, mute, sample
                } = region
                const fileBox = AudioFileBoxfactory.create(boxGraph, sample)
                const collectionBox = ValueEventCollectionBox.create(boxGraph, UUID.generate())
                const regionBox = AudioRegionBox.create(boxGraph, UUID.generate(), box => {
                    box.position.setValue(position)
                    box.duration.setValue(duration)
                    box.loopDuration.setValue(loopDuration)
                    box.loopOffset.setValue(loopOffset)
                    box.hue.setValue(hue)
                    box.label.setValue(label)
                    box.mute.setValue(mute)
                    box.regions.refer(trackBox.regions)
                    box.file.refer(fileBox)
                    box.events.refer(collectionBox.owners)
                    box.timeBase.setValue(region.playback === AudioPlayback.NoWarp ? TimeBase.Seconds : TimeBase.Musical)
                })
                // TODO TimeStretch and cleanup
                if (region.playback === AudioPlayback.PitchStretch) {
                    const pitchBox = AudioPitchStretchBox.create(boxGraph, UUID.generate())
                    WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
                        box.owner.refer(pitchBox.warpMarkers)
                        box.position.setValue(0)
                        box.seconds.setValue(0)
                    })
                    WarpMarkerBox.create(boxGraph, UUID.generate(), box => {
                        box.owner.refer(pitchBox.warpMarkers)
                        box.position.setValue(duration)
                        box.seconds.setValue(fileBox.endInSeconds.getValue())
                    })
                    regionBox.playMode.refer(pitchBox)
                }
            })
        })
    }
}