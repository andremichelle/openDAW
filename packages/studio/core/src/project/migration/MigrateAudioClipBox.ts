import {BoxGraph} from "@moises-ai/lib-box"
import {asInstanceOf, Float, UUID} from "@moises-ai/lib-std"
import {AudioClipBox, AudioFileBox, AudioPitchStretchBox, BoxIO, ValueEventCollectionBox} from "@moises-ai/studio-boxes"
import {AudioPlayback} from "@moises-ai/studio-enums"
import {TimeBase} from "@moises-ai/lib-dsp"
import {AudioContentHelpers} from "../audio/AudioContentHelpers"

const isIntEncodedAsFloat = (v: number) =>
    v > 0 && v < 1e-6 && Number.isFinite(v) && (v / 1.401298464324817e-45) % 1 === 0

export const migrateAudioClipBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: AudioClipBox): void => {
    if (box.events.isEmpty()) {
        console.debug("Migrate 'AudioClipBox' to have a ValueEventCollectionBox")
        boxGraph.beginTransaction()
        box.events.refer(ValueEventCollectionBox.create(boxGraph, UUID.generate()).owners)
        boxGraph.endTransaction()
    }
    if (isIntEncodedAsFloat(box.duration.getValue())) {
        console.debug("Migrate 'AudioClipBox' to float")
        boxGraph.beginTransaction()
        box.duration.setValue(Float.floatToIntBits(box.duration.getValue()))
        boxGraph.endTransaction()
    }
    if (box.playback.getValue() === AudioPlayback.Pitch) {
        console.debug("Migrate 'AudioClipBox' to new PitchStretchBox")
        boxGraph.beginTransaction()
        const file = asInstanceOf(box.file.targetVertex.unwrap(), AudioFileBox)
        const fileDuration = file.endInSeconds.getValue() - file.startInSeconds.getValue()
        const pitchBox = AudioPitchStretchBox.create(boxGraph, UUID.generate())
        AudioContentHelpers.addDefaultWarpMarkers(boxGraph, pitchBox, box.duration.getValue(), fileDuration)
        box.timeBase.setValue(TimeBase.Musical)
        box.playMode.refer(pitchBox)
        box.playback.setValue("")
        boxGraph.endTransaction()
    }
}
