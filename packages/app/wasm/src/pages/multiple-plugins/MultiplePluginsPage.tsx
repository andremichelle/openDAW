import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {ByteArrayInput, MutableObservableOption, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Synchronization, SyncSource, UpdateTask} from "@opendaw/lib-box"
import {AudioUnitBox, BoxIO, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {EngineStateSchema, ProjectSkeleton} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"
import {Env} from "../../Env"
import {serializeUpdateTasks} from "../../sync/serialize-update-tasks"
import {createEngineMemory, loadEngineModules} from "../../engine-modules"
import workletURL from "../metronome/engine-worklet.ts?worker&url"

// Two audio units, two parts, TWO different device plugins in one shared memory. device_sine.wasm and
// device_saw.wasm are loaded as PIC side modules at host-assigned bases (dynamic linking), and the engine
// builds one PluginInstrument per audio unit calling its device via the shared function table. The unit's
// `index` selects the device (slot index % device count): the bass (index 1) plays the SAWTOOTH, the
// arpeggio (index 2 -> slot 0) plays the SINE. So you hear a sawtooth bass under a sine arpeggio, proving
// two distinct device modules coexist and run independently from the one memory.

type Note = readonly [number, number] // [position in pulses, MIDI pitch]

// Unit A — bass: C2 E2 G2 E2 as quarter notes, looping every bar.
const BASS: ReadonlyArray<Note> = [
    [0, 36], [PPQN.Quarter, 40], [2 * PPQN.Quarter, 43], [3 * PPQN.Quarter, 40]
]
// Unit B — lead: C5 E5 G5 C6 as semiquavers, looping every quarter.
const LEAD: ReadonlyArray<Note> = [
    [0, 72], [PPQN.SemiQuaver, 76], [2 * PPQN.SemiQuaver, 79], [3 * PPQN.SemiQuaver, 84]
]

const TIMELINE = `unit A (bass)  C2 E2 G2 E2  quarter notes, loop = 1 bar   -> SAWTOOTH device
unit B (lead)  C5 E5 G5 C6  semiquavers,  loop = 1 quarter -> SINE device
both loop over bars 0..2 — two distinct device plugins, one shared memory`

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

    // One audio unit (own track + region + note collection) per part. The engine groups note regions by
    // their owning audio unit (region.regions -> track, track.tracks -> unit) into one instrument each, and
    // picks that unit's device by `index` (slot = index % device count): index 1 -> saw, index 2 -> sine.
    const addPart = (index: number, notes: ReadonlyArray<Note>, loopDuration: number, noteDuration: number): void => {
        const unit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
            box.collection.refer(mandatoryBoxes.rootBox.audioUnits)
            box.index.setValue(index)
        })
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

    boxGraph.beginTransaction()
    addPart(1, BASS, PPQN.Bar, PPQN.Quarter / 2)         // index 1 -> sawtooth device; staccato quarters
    addPart(2, LEAD, PPQN.Quarter, PPQN.SemiQuaver / 2)  // index 2 -> sine device; staccato semiquavers
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(2 * PPQN.Bar)
    timelineBox.loopArea.enabled.setValue(true)
    boxGraph.endTransaction()

    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        await ctx.audioWorklet.addModule(workletURL)
        const {engineModule, deviceModules} = await loadEngineModules()
        const memory = createEngineMemory()
        const workletNode = new AudioWorkletNode(ctx, "engine", {
            processorOptions: {engineModule, deviceModules, memory, sampleRate: ctx.sampleRate, metronome: false}
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
        append(`booted @ ${ctx.sampleRate} Hz — suspended; sawtooth bass + sine arpeggio (two device plugins)`)
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
            <p>Two audio units playing different parts through <strong>two different device plugins</strong>:
                a <strong>sawtooth</strong> bass and a <strong>sine</strong> arpeggio. <code>device_sine.wasm</code>
                and <code>device_saw.wasm</code> are loaded as position-independent side modules at
                host-assigned bases in <strong>one shared memory</strong> (dynamic linking), and the engine calls
                each unit's device through the shared function table. So a slow low sawtooth bass and a fast high
                sine arpeggio play at once and independently, from two distinct modules. Metronome off.</p>
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
