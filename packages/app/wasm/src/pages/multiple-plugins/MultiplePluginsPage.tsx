import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {ByteArrayInput, Iterables, MutableObservableOption, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Synchronization, SyncSource, UpdateTask} from "@opendaw/lib-box"
import {
    ArpeggioDeviceBox, AudioUnitBox, BoxIO, GrooveShuffleBox, NanoDeviceBox, NoteEventBox, NoteEventCollectionBox,
    NoteRegionBox, PitchDeviceBox, RevampDeviceBox, TrackBox, ValueEventBox, ValueEventCollectionBox, ValueRegionBox,
    VaporisateurDeviceBox, ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {EngineStateSchema, ProjectSkeleton, TrackType} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"
import {Env} from "../../Env"
import {serializeUpdateTasks} from "../../sync/serialize-update-tasks"
import {createEngineMemory, loadEngineModules} from "../../engine-modules"
import workletURL from "../metronome/engine-worklet.ts?worker&url"

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

type EngineMessage =
    | { readonly type: "state", readonly bytes: ArrayBuffer }
    | { readonly type: "heap", readonly heapUsed: number, readonly heapClaimed: number, readonly memoryTotal: number }

export const MultiplePluginsPage: PageFactory<Env> = ({lifecycle}) => {
    const context = new MutableObservableOption<AudioContext>()
    const node = new MutableObservableOption<AudioWorkletNode>()
    const log: HTMLPreElement = <pre/>
    const append = (line: string): void => {log.textContent = `${log.textContent ?? ""}${line}\n`}
    const state: HTMLPreElement = <pre>position: — | bpm: — | —</pre>
    const stateIO = EngineStateSchema()
    const showState = (bytes: ArrayBuffer): void => {
        stateIO.read(new ByteArrayInput(bytes))
        const {position, bpm, isPlaying} = stateIO.object
        const beat = position / PPQN.Quarter + 1
        state.textContent = `position: ${position.toFixed(0)} pulses (beat ${beat.toFixed(2)}) | bpm: ${bpm.toFixed(1)} | ${isPlaying ? "playing" : "stopped"}`
    }

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

    // One value-automation track bound 1:1 to a device parameter `target` (TS `TrackType.Value`): a region
    // over the 2-bar loop whose ValueEventCollection holds `points` ([position, 0..1 unit value]). The engine
    // reads it on the global update clock and pushes the unit value to the device, which maps it to its range.
    const addParamAutomation = (unit: AudioUnitBox, target: RevampDeviceBox["lowPass"]["frequency"],
                                points: Iterable<readonly [number, number]>): void => {
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
            // Box-field defaults (unit 0..1; the device maps): the value used when a parameter is NOT
            // automated. Cutoff mid, resonance at the bottom (Butterworth).
            box.lowPass.frequency.setValue(0.5)
            box.lowPass.q.setValue(0.0)
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
        VaporisateurDeviceBox.create(boxGraph, UUID.generate(), box => box.host.refer(unit.input))
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
        PitchDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.host.refer(unit.midiEffects)
            box.index.setValue(2)
        })
    })
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(2 * PPQN.Bar)
    timelineBox.loopArea.enabled.setValue(true)
    boxGraph.endTransaction()

    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        await ctx.audioWorklet.addModule(workletURL)
        const {engineModule, deviceModules, deviceBoxTypes} = await loadEngineModules()
        const memory = createEngineMemory()
        const workletNode = new AudioWorkletNode(ctx, "engine", {
            outputChannelCount: [2], // STEREO out; without this the node defaults to mono and drops the right channel
            processorOptions: {engineModule, deviceModules, deviceBoxTypes, memory, sampleRate: ctx.sampleRate, metronome: false}
        })
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        workletNode.port.onmessage = (event: MessageEvent<EngineMessage>) => {
            if (event.data.type === "state") {showState(event.data.bytes)}
        }
        const sender = new BroadcastChannel("multiple-plugins-sync")
        const receiver = new BroadcastChannel("multiple-plugins-sync")
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = serializeUpdateTasks(tasks, boxGraph)
                workletNode.port.postMessage(bytes, [bytes])
            },
            checksum(): Promise<void> {return Promise.resolve()}
        }
        lifecycle.own(Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(receiver), target))
        lifecycle.own(new SyncSource<BoxIO.TypeMap>(boxGraph, Messenger.for(sender), true))
        lifecycle.own({
            terminate: () => {
                sender.close()
                receiver.close()
            }
        })
        await ctx.suspend()
        append(`booted @ ${ctx.sampleRate} Hz — suspended; auto-wah sawtooth bass (left) + shuffled octave-up arpeggiated sine chord (right), six device plugins`)
    }

    const play = async (): Promise<void> => {
        if (context.nonEmpty()) {
            await context.unwrap().resume()
            append("playing")
        }
    }
    const stop = async (): Promise<void> => {
        if (context.nonEmpty()) {
            await context.unwrap().suspend()
            append("stopped")
        }
    }

    lifecycle.own({
        terminate: () => {
            node.ifSome(workletNode => workletNode.disconnect())
            context.ifSome(ctx => void ctx.close())
        }
    })
    void boot()
    return (
        <div className="page">
            <h2>Multiple Plugins</h2>
            <p>Two audio units playing different parts through <strong>six device plugins</strong>: two
                instruments, an audio effect, and a three-stage MIDI-fx chain. All run from
                <strong>one shared memory</strong>. Metronome off.</p>
            <ul>
                <li><strong>Dynamic linking.</strong> A <strong>sawtooth</strong> bass and a
                    <strong>sine</strong> lead (<code>device_sine.wasm</code>, <code>device_saw.wasm</code>)
                    load as position-independent side modules at host-assigned bases in the shared memory;
                    the engine calls each unit's device through the shared function table.</li>
                <li><strong>Audio effect with two automated parameters (bass only).</strong> A
                    <strong>biquad low-pass</strong> (<code>device_lowpass.wasm</code>) is inserted after the
                    bass: instrument&nbsp;→&nbsp;effect&nbsp;→&nbsp;bus. Its <strong>cutoff</strong> and
                    <strong>resonance</strong> are <strong>real parameters driven by automation</strong>,
                    bound 1:1 to the device's <code>lowPass.frequency</code> and <code>lowPass.q</code> fields.
                    The cutoff follows a sine sweep (points every 1/32 triplet, mapped exponentially to
                    80–1120&nbsp;Hz); the resonance sits at its default through the first bar then opens up to
                    a sharp peak by the loop end. On the <strong>global update clock</strong> the engine
                    resolves each parameter (its curve, or its box-field default when un-automated), pushes
                    only the changed ones to the device, and the device recomputes the filter — the auto-wah
                    is data, not a hard-coded LFO.</li>
                <li><strong>MIDI-fx pull chain (lead only).</strong> A three-stage chain sits before the lead:
                    sequencer&nbsp;←&nbsp;<code>arp</code>&nbsp;←&nbsp;<code>zeitgeist</code>&nbsp;←&nbsp;<code>transpose</code>&nbsp;←&nbsp;instrument.
                    The lead part is a single held C-E-G chord.</li>
                <li><strong>Arpeggiator.</strong> Holds the chord in its state block and emits a 1/16 stepped
                    sequence (a few held notes become a stream, NOT one-to-one), and keeps stepping across
                    blocks with no new input.</li>
                <li><strong>Zeitgeist.</strong> Shuffles the stream with a swing groove: it pulls its upstream
                    over an un-warped range and warps the positions back.</li>
                <li><strong>Transpose.</strong> Shifts every step up an octave.</li>
                <li><strong>Pull model.</strong> Each pull cascades up the chain; the MIDI fx are not audio
                    nodes, they produce events on demand, working in pulse positions while the instrument
                    resolves sample offsets.</li>
            </ul>
            <p>This proves instruments, the audio-effect path, and a multi-link MIDI-effect (event pull)
                chain all coexist and run from the one memory.</p>
            <pre className="timeline">{TIMELINE}</pre>
            <div>
                <button onclick={() => void play()}>▶ Play</button>
                <button onclick={() => void stop()}>■ Stop</button>
            </div>
            {state}
            {log}
        </div>
    )
}
