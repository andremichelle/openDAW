import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {UUID} from "@opendaw/lib-std"
import {applySinePatch} from "../../sine-patch"
import {AudioUnitBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, VaporisateurDeviceBox} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"
import {Env} from "../../Env"
import {createEngineHost} from "../../engine-host"

// Notes, end to end. Mirrored regions: ONE note collection (a 1-quarter arpeggio) shared by TWO
// regions — a 4-bar loop split at bar 2 — streamed via the unchanged SyncSource to the wasm engine,
// where the NoteSequencer plays each region and a sine instrument renders them.

// One quarter: C4 E4 G4 C5 as semiquavers (position in pulses from the quarter's start, MIDI pitch).
const ARPEGGIO: ReadonlyArray<readonly [number, number]> = [
    [0, 60], [PPQN.SemiQuaver, 64], [2 * PPQN.SemiQuaver, 67], [3 * PPQN.SemiQuaver, 72]
]

const TIMELINE = `bar   0       1       2       3       4      transport loops 0..4
      |-------|-------|-------|-------|
A     [===============]                      region A ──┐
B                     [===============]      region B ──┴── share one collection
      C4 E4 G4 C5 semiquavers, loopDuration = 1 quarter`

export const NotesPage: PageFactory<Env> = ({lifecycle}) => {
    const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const timelineBox = mandatoryBoxes.timelineBox

    boxGraph.beginTransaction()
    // MOCK SCAFFOLDING: the box graph requires a note region to live in a track inside an audio unit
    // (mandatory pointers: region.regions -> track, track.tracks -> unit, track.target -> unit,
    // unit.collection -> root). The wasm engine does NOT bind audio units or tracks at all — it finds
    // the NoteRegionBox by name and reads its span + note collection directly. So these two boxes are
    // throwaway structure to make the project valid, not a real audio-unit/track implementation.
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
    // Mirrored regions (see TIMELINE): ONE collection shared by TWO regions, each a 2-bar half of a
    // 4-bar loop. Both point `events` at the same collection's `owners`, so the arpeggio plays in both.
    const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    const region = (position: number) => NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.regions.refer(mockTrack.regions) // MOCK anchor (mandatory)
        box.position.setValue(position)
        box.duration.setValue(2 * PPQN.Bar)
        box.loopOffset.setValue(0)
        box.loopDuration.setValue(PPQN.Quarter) // the quarter arpeggio loops within each region
        box.events.refer(collection.owners) // both regions share this one collection
    })
    region(0)           // region A: bars 0..2
    region(2 * PPQN.Bar) // region B: bars 2..4 (the split)
    ARPEGGIO.forEach(([position, pitch]) => NoteEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(position)
        box.duration.setValue(PPQN.SemiQuaver / 2) // staccato, so each note is clearly separated
        box.pitch.setValue(pitch)
        box.velocity.setValue(0.8)
        box.events.refer(collection.events)
    }))
    // loop the whole four bars so both regions repeat.
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(4 * PPQN.Bar)
    timelineBox.loopArea.enabled.setValue(true)
    boxGraph.endTransaction()

    const host = createEngineHost(boxGraph, lifecycle, {channel: "notes-sync"})
    return (
        <div className="page">
            <h2>Notes</h2>
            <p>A C-major semiquaver arpeggio in one note collection shared by two mirrored regions, proving
                region sharing across a split 4-bar loop.</p>
            {host.element}
            <pre className="timeline">{TIMELINE}</pre>
            {host.log}
        </div>
    )
}
