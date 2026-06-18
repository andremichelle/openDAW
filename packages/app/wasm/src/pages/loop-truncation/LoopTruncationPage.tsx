import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {ByteArrayInput, MutableObservableOption, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {AudioUnitBox, BoxIO, NoteEventBox, NoteEventCollectionBox, NoteRegionBox, TrackBox} from "@opendaw/studio-boxes"
import {EngineStateSchema, ProjectSkeleton} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"
import {Env} from "../../Env"
import {serializeUpdateTasks} from "../../sync/serialize-update-tasks"
import workletURL from "../metronome/engine-worklet.ts?worker&url"

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
    // MOCK SCAFFOLDING: a region must live in a track inside an audio unit (mandatory pointers). The
    // engine ignores this hierarchy and reads the NoteRegionBox directly.
    const mockAudioUnit = AudioUnitBox.create(boxGraph, UUID.generate(), box => {
        box.collection.refer(mandatoryBoxes.rootBox.audioUnits)
        box.index.setValue(1)
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

    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        await ctx.audioWorklet.addModule(workletURL)
        const wasm = await fetch("/engine.wasm").then(response => response.arrayBuffer())
        const module = await WebAssembly.compile(wasm)
        const workletNode = new AudioWorkletNode(ctx, "engine", {processorOptions: {module, sampleRate: ctx.sampleRate, metronome: false}})
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        workletNode.port.onmessage = (event: MessageEvent<{type: string, bytes?: ArrayBuffer}>) => {
            if (event.data.type === "state" && event.data.bytes !== undefined) {showState(event.data.bytes)}
        }
        const sender = new BroadcastChannel("loop-truncation-sync")
        const receiver = new BroadcastChannel("loop-truncation-sync")
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = serializeUpdateTasks(tasks, boxGraph)
                workletNode.port.postMessage(bytes, [bytes])
            },
            checksum(): Promise<void> {return Promise.resolve()}
        }
        lifecycle.own(Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(receiver), target))
        lifecycle.own(new SyncSource<BoxIO.TypeMap>(boxGraph, Messenger.for(sender), true))
        lifecycle.own({terminate: () => {sender.close(); receiver.close()}})
        await ctx.suspend()
        append(`booted @ ${ctx.sampleRate} Hz — suspended; a bass note truncated at each loop wrap`)
    }

    const play = async (): Promise<void> => {
        if (context.nonEmpty()) {await context.unwrap().resume(); append("playing")}
    }
    const stop = async (): Promise<void> => {
        if (context.nonEmpty()) {await context.unwrap().suspend(); append("stopped")}
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
            <h2>Loop Truncation</h2>
            <p>A bar-looping region with a downbeat blip (C6) on beat 1 and a sustained note (C4)
                entering on beat 4 that is two quarters long. It would ring into the next bar, but the
                transport loops the bar, so the loop-wrap discontinuity must cut it off at the bar line.
                The note should stop exactly when the next downbeat fires, not bleed across the wrap.</p>
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
