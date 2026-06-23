import {createElement} from "@opendaw/lib-jsx"
import {ByteArrayInput, Lifecycle, MutableObservableOption} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Synchronization, SyncSource, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {EngineStateSchema, ProjectSkeleton} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"
import {serializeUpdateTasks} from "./sync/serialize-update-tasks"
import {createEngineMemory, loadEngineModules} from "./engine-modules"
import workletURL from "./pages/metronome/engine-worklet.ts?worker&url"

// The box graph type ProjectSkeleton hands back; every page drives the engine from one of these.
type EngineBoxGraph = ReturnType<typeof ProjectSkeleton.empty>["boxGraph"]

/// The shared engine host every page mounts: it boots the AudioWorklet engine, loads the device modules,
/// streams the page's box graph into it through the unchanged `SyncSource`, and decodes the engine-state
/// back-channel. Pages get the `state` / `log` elements and `play` / `stop`; the boot, sync wiring, and
/// teardown live here once instead of being copy-pasted per page.
export interface EngineHost {
    readonly state: HTMLPreElement
    readonly log: HTMLPreElement
    append(line: string): void
    play(): Promise<void>
    stop(): Promise<void>
}

export interface EngineHostOptions {
    readonly channel: string      // a BroadcastChannel name unique to the page (the SyncSource loopback)
    readonly metronome?: boolean  // the engine's built-in metronome click (default off)
}

export const createEngineHost = (boxGraph: EngineBoxGraph, lifecycle: Lifecycle, options: EngineHostOptions): EngineHost => {
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
    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        await ctx.audioWorklet.addModule(workletURL)
        const {engineModule, deviceModules, deviceBoxTypes} = await loadEngineModules()
        const memory = createEngineMemory()
        const workletNode = new AudioWorkletNode(ctx, "engine", {
            outputChannelCount: [2], // STEREO out; without this the node defaults to mono and drops the right channel
            processorOptions: {engineModule, deviceModules, deviceBoxTypes, memory, sampleRate: ctx.sampleRate, metronome: options.metronome ?? false}
        })
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        workletNode.port.onmessage = (event: MessageEvent<{type: string, bytes?: ArrayBuffer}>) => {
            if (event.data.type === "state" && event.data.bytes !== undefined) {showState(event.data.bytes)}
        }
        // SyncSource (unchanged) -> local BroadcastChannel loopback -> serialize (this graph's schema) -> worklet bytes.
        const sender = new BroadcastChannel(options.channel)
        const receiver = new BroadcastChannel(options.channel)
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
        append(`booted @ ${ctx.sampleRate} Hz — suspended`)
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
    return {state, log, append, play, stop}
}
