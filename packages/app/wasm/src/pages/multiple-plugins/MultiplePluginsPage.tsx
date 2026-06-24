import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {Iterables, UUID} from "@opendaw/lib-std"
import {
    ArpeggioDeviceBox, AudioUnitBox, GrooveShuffleBox, NanoDeviceBox, NoteEventBox, NoteEventCollectionBox,
    NoteRegionBox, PitchDeviceBox, RevampDeviceBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox,
    VaporisateurDeviceBox, ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"
import {Env} from "../../Env"
import {applySinePatch} from "../../sine-patch"
import {createEngineHost} from "../../engine-host"

type Note = readonly [number, number] // [position in pulses, MIDI pitch]

// Unit A — bass: C2 E2 G2 E2 as quarter notes, looping every bar.
const BASS: ReadonlyArray<Note> = [
    [0, 36], [PPQN.Quarter, 40], [2 * PPQN.Quarter, 43], [3 * PPQN.Quarter, 40]
]
// Unit B — lead: a held C5-E5-G5 chord (all at position 0), looping every bar. The arpeggiator device
// turns it into a 1/16 stepped sequence; the chord is held the whole bar so the arp has notes to step.
const LEAD: ReadonlyArray<Note> = [
    [0, 72], [0, 76], [0, 79]
]

// The bass low-pass cutoff AUTOMATION curve (Route D). A 0..1 unit curve sampled every 1/32 triplet
// (Quarter / 12 = 80 pulses), one sine sweep per half-note: value = (sin + 1) / 2. The lowpass device maps
// 0..1 EXPONENTIALLY to 80..1120 Hz; the auto-wah is data read on the global update clock, not computed in
// the device. (Resonance is a second automated parameter, built inline below.)
const CUTOFF_STEP = PPQN.Quarter / 12   // 1/32 triplet
const CUTOFF_PERIOD = 2 * PPQN.Quarter  // one sweep per half-note

const TIMELINE = `unit A (bass)  C2 E2 G2 E2     quarter notes,  loop = 1 bar -> SAWTOOTH -> TEMPO-SYNC LOW-PASS
unit B (lead)  C5+E5+G5 held chord, loop = 1 bar -> ARP (1/16) -> SHUFFLE -> TRANSPOSE +12 -> SINE
both loop over bars 0..2 — two instruments + an audio effect + a 3-stage MIDI-fx chain, one shared memory`

export const MultiplePluginsPage: PageFactory<Env> = ({lifecycle}) => {
    const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const timelineBox = mandatoryBoxes.timelineBox

    // One audio unit per part, with its real device boxes. The engine reads each unit's `input` instrument,
    // `midi-effects` and `audio-effects` chains (ordered by each device's `index`) from the box graph and
    // dispatches each device box to its plugin via the device table. `buildDevices` attaches the unit's
    // devices; the host hooks them up (no slot / load-order stopgap).
    const addPart = (index: number, panning: number, notes: ReadonlyArray<Note>, loopDuration: number,
                     noteDuration: number, buildDevices: (unit: AudioUnitBox) => void): void => {
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(mandatoryBoxes.rootBox.audioUnits)
            box.index.setValue(index)
            box.panning.setValue(panning) // the channel strip pans the unit: -1 hard left, +1 hard right
        })
        buildDevices(unit)
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
            box.loopDuration.setValue(loopDuration)
            box.events.refer(collection.owners)
        })
        notes.forEach(([position, pitch]) => NoteEventBox.create(boxGraph, UUID.generate(), box => {
            box.position.setValue(position)
            box.duration.setValue(noteDuration)
            box.pitch.setValue(pitch)
            box.velocity.setValue(0.8)
            box.events.refer(collection.events)
        }))
    }

    // One value-automation track bound 1:1 to a device parameter `target` (TS `TrackType.Value`, any field
    // that accepts an Automation pointer): a region over the 2-bar loop whose ValueEventCollection holds
    // `points` ([position, UNIFORM 0..1 value]). The engine reads it on the global update clock and hands the
    // uniform value to the device, which maps it (cutoff -> Hz, semitones -> int, etc.). `interpolation`
    // (0 = none / step, 1 = linear) defaults to the box default (linear) when omitted.
    const addParamAutomation = (unit: AudioUnitBox, target: Parameters<TrackBox["target"]["refer"]>[0],
                                points: Iterable<readonly [number, number]>, interpolation?: number): void => {
        const loopLength = 2 * PPQN.Bar
        const track = TrackBox.create(boxGraph, UUID.generate(), box => {
            box.tracks.refer(unit.tracks)
            box.type.setValue(TrackType.Value)
            box.target.refer(target) // the 1:1 parameter <-> automation-track binding
        })
        const collection = ValueEventCollectionBox.create(boxGraph, UUID.generate())
        ValueRegionBox.create(boxGraph, UUID.generate(), box => {
            box.regions.refer(track.regions)
            box.position.setValue(0)
            box.duration.setValue(loopLength)
            box.loopOffset.setValue(0)
            box.loopDuration.setValue(loopLength)
            box.events.refer(collection.owners)
        })
        Iterables.forEach(points, ([position, value]) => {
            ValueEventBox.create(boxGraph, UUID.generate(), box => {
                box.position.setValue(position)
                box.value.setValue(value)
                if (interpolation !== undefined) {box.interpolation.setValue(interpolation)}
                box.events.refer(collection.events)
            })
        })
    }

    boxGraph.beginTransaction()
    // Bass: a sawtooth instrument (Nano) into a low-pass audio effect (Revamp) with TWO automated parameters,
    // panned hard LEFT.
    addPart(1, -1.0, BASS, PPQN.Bar, PPQN.Quarter / 2, unit => {
        NanoDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
        const revamp = RevampDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.audioEffects)
            box.index.setValue(0)
            // Box-field defaults are the parameter's REAL value (what a UI edit would write) — used when a
            // parameter is NOT automated. The device reads them directly; only the 0..1 automation curve is
            // mapped. Cutoff 600 Hz, resonance Butterworth (0.707).
            box.lowPass.frequency.setValue(600.0)
            box.lowPass.q.setValue(Math.SQRT1_2)
        })
        // Cutoff: an exponential sine auto-wah, points every 1/32 triplet (see CUTOFF_* above).
        addParamAutomation(unit, revamp.lowPass.frequency,
            Iterables.map(Iterables.range(0, 2 * PPQN.Bar, CUTOFF_STEP),
                position => [position, (Math.sin((2 * Math.PI * position) / CUTOFF_PERIOD) + 1.0) / 2.0] as const))
        // Resonance: flat at the default through the first bar, then opening up to a sharp peak by the loop
        // end (and resetting on the loop) — "starts at default, goes up at the end".
        addParamAutomation(unit, revamp.lowPass.q, [[0, 0.0], [PPQN.Bar, 0.0], [2 * PPQN.Bar, 1.0]] as const)
    })
    // Lead: a sine instrument (Vaporisateur) behind a 3-stage MIDI-fx chain ordered by index:
    // arp (0) -> zeitgeist (1) -> transpose (2), panned hard RIGHT. The chord is held a full bar.
    addPart(2, 1.0, LEAD, PPQN.Bar, PPQN.Bar, unit => {
        VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.input)
            applySinePatch(box)
        })
        ArpeggioDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(0)
        })
        // Zeitgeist's `groove` is a mandatory pointer to a Groove; give it a GrooveShuffleBox. (Our device
        // uses a fixed groove for now; the box satisfies the model and is where its params will bind later.)
        const groove = GrooveShuffleBox.create(boxGraph, UUID.generate(), box => box.label.setValue("Shuffle"))
        ZeitgeistDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(1)
            box.groove.refer(groove)
        })
        const pitch = PitchDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(2)
        })
        // Transpose (a MIDI-fx parameter, automated): a UNIFORM 0..1 curve the device maps through its
        // LinearInteger(0, 12) mapping — 0.0 (= 0 semitones) through the first bar, then a STEP up to 1.0
        // (= +12, an octave) for the second bar, repeating each loop. NO interpolation, so it jumps at the bar.
        addParamAutomation(unit, pitch.semiTones, [[0, 0.0], [PPQN.Bar, 1.0]] as const, 0)
    })
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(2 * PPQN.Bar)
    timelineBox.loopArea.enabled.setValue(true)
    boxGraph.endTransaction()

    const host = createEngineHost(boxGraph, lifecycle, {channel: "multiple-plugins-sync"})
    return (
        <div className="page">
            <h2>Multiple Plugins</h2>
            <p>Two audio units through six plugins from one shared memory: a sampler bass and a sine lead,
                an automated low-pass on the bass, and a three-stage MIDI-fx pull chain on the lead.</p>
            {host.element}
            <ul>
                <li><strong>Bass:</strong> sampler → automated biquad low-pass (cutoff sweep + resonance,
                    both real automated parameters) → bus.</li>
                <li><strong>Lead:</strong> a held C-E-G chord pulled through arp → zeitgeist (swing) →
                    transpose (automated +12 every other bar) → sine.</li>
                <li>Proves instruments, the audio-effect path, and a multi-link MIDI-fx event-pull chain
                    coexisting in one memory.</li>
            </ul>
            <pre className="timeline">{TIMELINE}</pre>
            {host.log}
        </div>
    )
}
