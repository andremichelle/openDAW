import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {MutableObservableOption} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {SyncSource, Synchronization, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {ProjectSkeleton} from "@opendaw/studio-adapters"
import {Env} from "../../Env"
import {serializeUpdateTasks} from "../../sync/serialize-update-tasks"
import {createEngineMemory, loadEngineModules} from "../../engine-modules"
import workletURL from "./engine-worklet.ts?worker&url"

// Live metronome: a real project (TimelineBox) on the main thread; the unchanged SyncSource ships
// every transaction to the wasm engine in the AudioWorklet, which advances the transport and renders
// the click continuously. Editing bpm / signature mutates the TimelineBox -> SyncSource -> engine
// (via catchupAndSubscribe), so the playing metronome reacts live. Serialization runs here (the
// schema lives in this graph); the worklet only receives bytes.

const DENOMINATORS = [1, 2, 4, 8, 16]
const NOMINATORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12]

export const MetronomePage: PageFactory<Env> = ({lifecycle}) => {
    const context = new MutableObservableOption<AudioContext>()
    const node = new MutableObservableOption<AudioWorkletNode>()
    const log: HTMLPreElement = <pre/>
    const append = (line: string): void => {log.textContent = `${log.textContent ?? ""}${line}\n`}

    const memory: HTMLPreElement = <pre>memory: waiting…</pre>
    const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`
    type HeapStats = {heapUsed: number, heapClaimed: number, memoryTotal: number}
    const showMemory = ({heapUsed, heapClaimed, memoryTotal}: HeapStats): void => {
        memory.textContent = `heap: ${kb(heapUsed)} used / ${kb(heapClaimed)} claimed | linear memory: ${kb(memoryTotal)}`
    }

    const {boxGraph, mandatoryBoxes} = ProjectSkeleton.empty({createOutputMaximizer: false, createDefaultUser: false})
    const timelineBox = mandatoryBoxes.timelineBox

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
        const workletNode = new AudioWorkletNode(ctx, "engine", {
            processorOptions: {engineModule, deviceModules, deviceBoxTypes, memory, sampleRate: ctx.sampleRate}
        })
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        workletNode.port.onmessage = (event: MessageEvent) => {
            if ((event.data as {type: string}).type === "heap") {showMemory(event.data as HeapStats)}
        }
        // SyncSource (unchanged) -> local loopback -> serialize (this graph's schema) -> worklet bytes
        const sender = new BroadcastChannel("metronome-sync")
        const receiver = new BroadcastChannel("metronome-sync")
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
        append(`booted @ ${ctx.sampleRate} Hz — suspended; bpm 120, 4/4`)
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

    const bpmLabel: HTMLSpanElement = <span>120</span>
    const setBpm = (value: number): void => {
        bpmLabel.textContent = String(value)
        edit(() => timelineBox.bpm.setValue(value))
    }
    const setNominator = (value: number): void => edit(() => timelineBox.signature.nominator.setValue(value))
    const setDenominator = (value: number): void => edit(() => timelineBox.signature.denominator.setValue(value))

    lifecycle.own({
        terminate: () => {
            node.ifSome(workletNode => workletNode.disconnect())
            context.ifSome(ctx => void ctx.close())
        }
    })
    void boot()
    return (
        <div className="page">
            <h2>Metronome</h2>
            <p>The unchanged SyncSource streams TimelineBox edits to the wasm engine in the worklet,
                which renders the click live. bpm + signature changes apply while playing.</p>
            <div>
                <button onclick={() => void play()}>▶ Play</button>
                <button onclick={() => void stop()}>■ Stop</button>
            </div>
            <div>
                <label>BPM {bpmLabel} </label>
                <input type="range" min="40" max="240" value="120"
                       oninput={(event: Event) => setBpm(parseInt((event.target as HTMLInputElement).value, 10))}/>
            </div>
            <div>
                <label>Signature </label>
                <select onchange={(event: Event) => setNominator(parseInt((event.target as HTMLSelectElement).value, 10))}>
                    {NOMINATORS.map(value => <option value={String(value)} selected={value === 4}>{String(value)}</option>)}
                </select>
                <span> / </span>
                <select onchange={(event: Event) => setDenominator(parseInt((event.target as HTMLSelectElement).value, 10))}>
                    {DENOMINATORS.map(value => <option value={String(value)} selected={value === 4}>{String(value)}</option>)}
                </select>
            </div>
            {memory}
            {log}
        </div>
    )
}
