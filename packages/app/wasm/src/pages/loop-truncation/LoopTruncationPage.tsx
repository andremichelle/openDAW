import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {UUID} from "@opendaw/lib-std"
import {AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {applySinePatch} from "../../sine-patch"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"

// Loop-end truncation test. A bar-looping note region holds a short downbeat note (beat 1) and a note
// that enters on the last beat and is two quarters long, so it WANTS to ring into the next bar. The
// transport loops the bar, so each wrap the loop-wrap discontinuity must cut it off at the bar line.
// If the note stops exactly when the next downbeat fires, truncation works; if it bleeds across the
// wrap, it does not.

const TIMELINE = `region = 1 bar, looped by the transport; every cycle replays the same content.

beat    1   2   3   4 | 1   2   3   4     | = bar end = loop wrap
        |---|---|---|---|---|---|---|---|
region  [=============]  [=============]   one bar, replayed by the loop
blip    *               *                 C6 blip on beat 1, each cycle
note                [==X            [==X   C4 on beat 4 (2 quarters): it would
                                           ring past the bar, but is cut at
                                           every wrap (X) instead of held over`

export const LoopTruncationPage: PageFactory<Env> = ({lifecycle}) => {
    const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const timelineBox = mandatoryBoxes.timelineBox

    boxGraph.beginTransaction()
    // MOCK SCAFFOLDING: a region must live in a track inside an audio unit (mandatory pointers). The
    // engine ignores this hierarchy and reads the NoteRegionBox directly.
    const mockAudioUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.collection.refer(mandatoryBoxes.rootBox.audioUnits)
        box.index.setValue(0)
    })
    // The unit's instrument: a sine (Vaporisateur) device box on the `input` host; the engine reads it from
    // the box and instantiates device_sine.wasm via the device table.
    VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(mockAudioUnit.input)
        applySinePatch(box)
    })
    const mockTrack = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.tracks.refer(mockAudioUnit.tracks)
        box.target.refer(mockAudioUnit)
    })
    // One bar-looping region: nothing retriggers within the bar, so the bass is one sustained note.
    const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.regions.refer(mockTrack.regions) // MOCK anchor (mandatory)
        box.position.setValue(0)
        box.duration.setValue(PPQN.Bar)
        box.loopOffset.setValue(0)
        box.loopDuration.setValue(PPQN.Bar)
        box.events.refer(collection.owners)
    })
    // A short downbeat marker on beat 1, so the bar boundary is audible.
    NoteEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.duration.setValue(PPQN.SemiQuaver / 2)
        box.pitch.setValue(84) // C6, a high blip
        box.velocity.setValue(0.7)
        box.events.refer(collection.events)
    })
    // The sustained note (middle C): enters on beat 4, two quarters long, so it would ring into the
    // next bar — the loop-wrap discontinuity must truncate it at the bar line.
    NoteEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(3 * PPQN.Quarter) // beat 4
        box.duration.setValue(2 * PPQN.Quarter)
        box.pitch.setValue(60) // C4, clearly audible and well below the C6 downbeat blip
        box.velocity.setValue(0.8)
        box.events.refer(collection.events)
    })
    // loop the single bar.
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(PPQN.Bar)
    timelineBox.loopArea.enabled.setValue(true)
    boxGraph.endTransaction()

    const host = createEngineHost(boxGraph, lifecycle, {channel: "loop-truncation-sync"})
    return (
        <div className="page">
            <h2>Loop Truncation</h2>
            <p>A bar loop with a note that would ring past the bar line: the loop-wrap discontinuity must cut
                it off exactly at the wrap, not bleed into the next bar.</p>
            {host.element}
            <pre className="timeline">{TIMELINE}</pre>
            {host.log}
        </div>
    )
}
