import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {ByteArrayInput, MutableObservableOption, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO, ValueEventBox, ValueEventCollectionBox, ValueEventCurveBox} from "@opendaw/studio-boxes"
import {EngineStateSchema, ProjectSkeleton} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {serializeUpdateTasks} from "../../sync/serialize-update-tasks"
import {createEngineMemory, loadEngineModules} from "../../engine-modules"
import workletURL from "../metronome/engine-worklet.ts?worker&url"

const BAR = 3840 // pulses (PPQN: 960 per quarter, 4/4)
const LOOP_TO = 4 * BAR // 15360, the LoopArea default

// Tagged messages the engine worklet posts back (see engine-worklet.ts).
type EngineMessage =
    | {readonly type: "state", readonly bytes: ArrayBuffer}
    | {readonly type: "heap", readonly heapUsed: number, readonly heapClaimed: number, readonly memoryTotal: number}

export const TempoAutomationPage: PageFactory<Env> = ({lifecycle}) => {
    const context = new MutableObservableOption<AudioContext>()
    const node = new MutableObservableOption<AudioWorkletNode>()
    const log: HTMLPreElement = <pre/>
    const append = (line: string): void => {log.textContent = `${log.textContent ?? ""}${line}\n`}

    const state: HTMLPreElement = <pre>position: — | bpm: — | —</pre>
    const stateIO = EngineStateSchema()
    const showState = (bytes: ArrayBuffer): void => {
        stateIO.read(new ByteArrayInput(bytes))
        const {position, bpm, isPlaying} = stateIO.object
        const bar = position / BAR + 1 // 1-based for display
        state.textContent = `position: ${position.toFixed(0)} pulses (bar ${bar.toFixed(2)}) | bpm: ${bpm.toFixed(1)} | ${isPlaying ? "playing" : "stopped"}`
    }

    const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const timelineBox = mandatoryBoxes.timelineBox

    // ProjectSkeleton already creates the tempo ValueEventCollectionBox and wires tempoTrack.events to
    // it (owners is mandatory), so reuse that collection rather than orphan it. Add two events plus the
    // loop area over bars 0..4, and a curve on the first event for a gentler initial acceleration.
    const collection = timelineBox.tempoTrack.events.targetVertex.unwrap().box as ValueEventCollectionBox
    boxGraph.beginTransaction()
    const firstEvent = ValueEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(0)
        box.value.setValue(30) // our engine reads value as raw bpm
        box.events.refer(collection.events)
    })
    // a curve box shapes the first event's segment: slope < 0.5 keeps the tempo low at first, then
    // ramps up faster (slope 0.5 would be linear). It targets the event's interpolation field.
    ValueEventCurveBox.create(boxGraph, UUID.generate(), curve => {
        curve.slope.setValue(0.3)
        curve.event.refer(firstEvent.interpolation)
    })
    ValueEventBox.create(boxGraph, UUID.generate(), box => {
        box.position.setValue(LOOP_TO)
        box.value.setValue(1000)
        box.events.refer(collection.events)
    })
    timelineBox.loopArea.from.setValue(0)
    timelineBox.loopArea.to.setValue(LOOP_TO)
    timelineBox.loopArea.enabled.setValue(true)
    boxGraph.endTransaction()

    const edit = (procedure: () => void): void => {
        boxGraph.beginTransaction()
        procedure()
        boxGraph.endTransaction()
    }

    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        await ctx.audioWorklet.addModule(workletURL)
        const {engineModule, deviceModules, deviceBoxTypes} = await loadEngineModules()
        const memory = createEngineMemory()
        const workletNode = new AudioWorkletNode(ctx, "engine", {processorOptions: {engineModule, deviceModules, deviceBoxTypes, memory, sampleRate: ctx.sampleRate}})
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        workletNode.port.onmessage = (event: MessageEvent<EngineMessage>) => {
            if (event.data.type === "state") {showState(event.data.bytes)}
        }
        const sender = new BroadcastChannel("tempo-sync")
        const receiver = new BroadcastChannel("tempo-sync")
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
        append(`booted @ ${ctx.sampleRate} Hz — suspended; tempo 30→1000 bpm over bars 0..4, looping`)
    }

    const play = async (): Promise<void> => {
        if (context.nonEmpty()) {await context.unwrap().resume(); append("playing")}
    }
    const stop = async (): Promise<void> => {
        if (context.nonEmpty()) {await context.unwrap().suspend(); append("stopped")}
    }
    const setTempoEnabled = (enabled: boolean): void => edit(() => timelineBox.tempoTrack.enabled.setValue(enabled))

    const bpmLabel: HTMLSpanElement = <span>120</span>
    const setBpm = (value: number): void => {
        bpmLabel.textContent = String(value)
        edit(() => timelineBox.bpm.setValue(value))
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
            <h2>Tempo Automation</h2>
            <p>Tempo events on the TimelineBox tempo track: 30 bpm at bar 0 rising to 1000 bpm at bar 4,
                with a curve on the first event so it accelerates gently at first. A 4-bar loop wraps it
                back to the start. Turn tempo automation off to hear the fixed bpm from the slider
                instead. Position, bpm, and transport state come from the engine's EngineState
                back-channel (~30 Hz), decoded with the real EngineStateSchema.</p>
            <div>
                <button onclick={() => void play()}>▶ Play</button>
                <button onclick={() => void stop()}>■ Stop</button>
            </div>
            <div>
                <label>
                    <input type="checkbox" checked={true}
                           onchange={(event: Event) => setTempoEnabled((event.target as HTMLInputElement).checked)}/>
                    Tempo automation (on = 30→1000 bpm ramp; off = fixed 120 bpm). Loops the first 4 bars either way.
                </label>
            </div>
            <div>
                <label>BPM {bpmLabel} </label>
                <input type="range" min="40" max="240" value="120"
                       oninput={(event: Event) => setBpm(parseInt((event.target as HTMLInputElement).value, 10))}/>
            </div>
            {state}
            {log}
        </div>
    )
}
