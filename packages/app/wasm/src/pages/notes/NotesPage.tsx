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

type EngineMessage =
    | { readonly type: "state", readonly bytes: ArrayBuffer }
    | { readonly type: "heap", readonly heapUsed: number, readonly heapClaimed: number, readonly memoryTotal: number }

export const NotesPage: PageFactory<Env> = ({lifecycle}) => {
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

    boxGraph.beginTransaction()
    // MOCK SCAFFOLDING: the box graph requires a note region to live in a track inside an audio unit
    // (mandatory pointers: region.regions -> track, track.tracks -> unit, track.target -> unit,
    // unit.collection -> root). The wasm engine does NOT bind audio units or tracks at all — it finds
    // the NoteRegionBox by name and reads its span + note collection directly. So these two boxes are
    // throwaway structure to make the project valid, not a real audio-unit/track implementation.
    const mockAudioUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.collection.refer(mandatoryBoxes.rootBox.audioUnits)
        box.index.setValue(0) // device slot 0 (sine)
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

    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        await ctx.audioWorklet.addModule(workletURL)
        const {engineModule, deviceModules} = await loadEngineModules()
        const memory = createEngineMemory()
        const workletNode = new AudioWorkletNode(ctx, "engine", {
            processorOptions: {
                engineModule,
                deviceModules,
                memory,
                sampleRate: ctx.sampleRate,
                metronome: false
            }
        })
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        workletNode.port.onmessage = (event: MessageEvent<EngineMessage>) => {
            if (event.data.type === "state") {showState(event.data.bytes)}
        }
        const sender = new BroadcastChannel("notes-sync")
        const receiver = new BroadcastChannel("notes-sync")
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
        append(`booted @ ${ctx.sampleRate} Hz — suspended; two mirrored regions sharing one arpeggio`)
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
            <h2>Notes</h2>
            <p>A C-major arpeggio (C4 E4 G4 C5) in semiquavers, looping every quarter. It lives in one
                note collection shared by <strong>two mirrored regions</strong> — a 4-bar loop split at
                bar 2 into two 2-bar halves — so the same arpeggio plays in both halves. The NoteSequencer
                plays each region; if region sharing were broken, bars 2–4 would fall silent. Metronome
                off.</p>
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
