import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {UUID} from "@opendaw/lib-std"
import {
    ArpeggioDeviceBox, AudioFileBox, AudioUnitBox, CompositeCellBox, CompositeDeviceBox, DelayDeviceBox,
    NanoDeviceBox, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox, VaporisateurDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"
import {Env} from "../../Env"
import {applySinePatch} from "../../sine-patch"
import {createEngineHost} from "../../engine-host"

type Note = readonly [number, number] // [position in pulses, MIDI pitch]

// A C-E-G chord held a full bar, looping. Both instruments inside the composite play it.
const CHORD: ReadonlyArray<Note> = [[0, 60], [0, 64], [0, 67]]

// A real CDN sample (assets.opendaw.studio/samples), lifted from public/projects/nano.od, so the Nano child has
// something to play. Its AudioFileBox UUID IS the sample UUID the loader fetches.
const TOY_PIANO_UUID = "a3b05d07-e4ac-4ba7-9dc8-63564481ef39"

export const CompositePage: PageFactory<Env> = ({lifecycle}) => {
    const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const timelineBox = mandatoryBoxes.timelineBox

    boxGraph.beginTransaction()
    const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.collection.refer(mandatoryBoxes.rootBox.audioUnits)
        box.index.setValue(0)
    })
    // The unit's instrument is a generic COMPOSITE bundling two FULL instruments. Each instrument lives in its
    // own CELL (CompositeCellBox), which hosts the instrument plus its own midi / audio fx chains, the way an
    // audio unit hosts an instrument and its chains. The instrument and any effect attach to the cell by their
    // normal `host` pointers, so NO instrument or effect plugin changes to live inside the composite. The
    // composite broadcasts every note to both cells, so both play the chord, summed into one output.
    const composite = CompositeDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
    // Cell 1: a Vaporisateur (sine) with an Arp on the cell's own MIDI-fx chain, so only the Vapo is
    // arpeggiated (it pulls the held chord through the arp into a 1/16 sequence) while the Nano plays the chord
    // straight. The Arp is an unchanged MIDI-fx plugin attached to the cell by its normal `host` pointer.
    const vapoCell = CompositeCellBox.create(boxGraph, UUID.generate(), box => {
        box.composite.refer(composite.cells)
        box.index.setValue(0)
    })
    VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(vapoCell.instrument)
        applySinePatch(box)
    })
    ArpeggioDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(vapoCell.midiEffects)
        box.index.setValue(0)
    })
    // Cell 2: a Nano (ToyPiano sample) into a Delay AUDIO EFFECT on the cell's own audio-fx chain. The delay's
    // box-field defaults already give an audible synced echo (wet -6 dB, feedback 0.5), so only the Nano child
    // gets the delay, proving a per-child audio chain inside the composite with an unchanged Delay plugin.
    const sample = AudioFileBox.create(boxGraph, UUID.parse(TOY_PIANO_UUID), box => {
        box.fileName.setValue("ToyPiano")
        box.startInSeconds.setValue(0)
        box.endInSeconds.setValue(2.0)
    })
    const nanoCell = CompositeCellBox.create(boxGraph, UUID.generate(), box => {
        box.composite.refer(composite.cells)
        box.index.setValue(1)
    })
    NanoDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(nanoCell.instrument)
        box.file.refer(sample)
    })
    DelayDeviceBox.create(boxGraph, UUID.generate(), box => {
        box.host.refer(nanoCell.audioEffects)
        box.index.setValue(0)
    })
    // One note track on the unit: the held chord, looping each bar over two bars.
    const track = TrackBox.create(boxGraph, UUID.generate(), box => {
        box.tracks.refer(unit.tracks)
        box.target.refer(unit)
    })
    const collection = NoteEventCollectionBox.create(boxGraph, UUID.generate())
    NoteRegionBox.create(boxGraph, UUID.generate(), box => {
        box.regions.refer(track.regions)
        box.position.setValue(0)
        box.duration.setValue(2 * PPQN.Bar)
        box.loopOffset.setValue(0)
        box.loopDuration.setValue(PPQN.Bar)
        box.events.refer(collection.owners)
    })
    CHORD.forEach(([position, pitch]) => NoteEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(position)
        box.duration.setValue(PPQN.Bar)
        box.pitch.setValue(pitch)
        box.velocity.setValue(0.8)
        box.events.refer(collection.events)
    }))
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(2 * PPQN.Bar)
    timelineBox.loopArea.enabled.setValue(true)
    boxGraph.endTransaction()

    const host = createEngineHost(boxGraph, lifecycle, {channel: "composite-sync"})
    return (
        <div className="page">
            <h2>Composite</h2>
            <p>A generic <code>CompositeDeviceBox</code> hosts two instruments, each in its own cell with its own
                chains: a Vaporisateur arpeggiated by a per-cell Arp, and a Nano (ToyPiano) echoed by a per-cell
                Delay. Both play the same broadcast chord; every instrument and effect is an unchanged plugin.</p>
            {host.element}
        </div>
    )
}
