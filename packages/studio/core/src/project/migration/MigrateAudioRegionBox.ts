import {BoxGraph} from "@opendaw/lib-box"
import {asInstanceOf, Float, UUID, ValueOwner} from "@opendaw/lib-std"
import {AudioFileBox, AudioPitchStretchBox, AudioRegionBox, BoxIO, ValueEventCollectionBox} from "@opendaw/studio-boxes"
import {AudioPlayback} from "@opendaw/studio-enums"
import {PPQN, ppqn, seconds, TimeBase} from "@opendaw/lib-dsp"
import {AudioContentHelpers} from "../audio/AudioContentHelpers"

const isIntEncodedAsFloat = (v: number) =>
    v > 0 && v < 1e-6 && Number.isFinite(v) && (v / 1.401298464324817e-45) % 1 === 0

const toSeconds = (property: ValueOwner<ppqn>, bpm: number): seconds =>
    PPQN.pulsesToSeconds(property.getValue(), bpm)

export const migrateAudioRegionBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: AudioRegionBox, bpm: number): void => {
    const {duration, loopOffset, loopDuration, playback} = box
    if (isIntEncodedAsFloat(duration.getValue())
        || isIntEncodedAsFloat(loopOffset.getValue())
        || isIntEncodedAsFloat(loopDuration.getValue())) {
        console.debug("Migrate 'AudioRegionBox' to float")
        boxGraph.beginTransaction()
        duration.setValue(Float.floatToIntBits(duration.getValue()))
        loopOffset.setValue(Float.floatToIntBits(loopOffset.getValue()))
        loopDuration.setValue(Float.floatToIntBits(loopDuration.getValue()))
        boxGraph.endTransaction()
    }
    if (playback.getValue() === AudioPlayback.AudioFit) {
        console.debug("Migrate 'AudioRegionBox' to AudioPlayback.NoSync")
        boxGraph.beginTransaction()
        const file = asInstanceOf(box.file.targetVertex.unwrap(), AudioFileBox)
        const fileDuration = file.endInSeconds.getValue() - file.startInSeconds.getValue()
        const currentLoopDurationSeconds = toSeconds(box.loopDuration, bpm)
        const scale = fileDuration / currentLoopDurationSeconds
        const currentDurationSeconds = toSeconds(box.duration, bpm)
        const currentLoopOffsetSeconds = toSeconds(box.loopOffset, bpm)
        box.timeBase.setValue(TimeBase.Seconds)
        box.duration.setValue(currentDurationSeconds * scale)
        box.loopDuration.setValue(fileDuration)
        box.loopOffset.setValue(currentLoopOffsetSeconds * scale)
        box.playback.setValue("")
        boxGraph.endTransaction()
    } else if (playback.getValue() === AudioPlayback.Pitch) {
        console.debug("Migrate 'AudioRegionBox' to new PitchStretchBox")
        boxGraph.beginTransaction()
        const file = asInstanceOf(box.file.targetVertex.unwrap(), AudioFileBox)
        const fileDuration = file.endInSeconds.getValue() - file.startInSeconds.getValue()
        const pitchBox = AudioPitchStretchBox.create(boxGraph, UUID.generate())
        AudioContentHelpers.addDefaultWarpMarkers(boxGraph, pitchBox, box.loopDuration.getValue(), fileDuration)
        box.timeBase.setValue(TimeBase.Musical)
        box.playMode.refer(pitchBox)
        box.playback.setValue("")
        boxGraph.endTransaction()
    }
    if (box.events.isEmpty()) {
        console.debug("Migrate 'AudioRegionBox' to have a ValueEventCollectionBox")
        boxGraph.beginTransaction()
        box.events.refer(ValueEventCollectionBox.create(boxGraph, UUID.generate()).owners)
        boxGraph.endTransaction()
    }
}
