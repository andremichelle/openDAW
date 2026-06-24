import {createElement} from "@opendaw/lib-jsx"
import {asDefined, ByteArrayInput, Lifecycle, MutableObservableOption, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Synchronization, SyncSource, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {EngineStateSchema, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioData, PPQN} from "@opendaw/lib-dsp"
import {SampleInfo, SampleLoader} from "./sample-loader"
import {EngineProtocol, TransportListener} from "./engine-protocol"
import {loadSample} from "./sample-fetch"
import {serializeUpdateTasks} from "./sync/serialize-update-tasks"
import {createEngineMemory, loadEngineModules} from "./engine-modules"
import processorURL from "./engine-processor.ts?worker&url"

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
        await ctx.audioWorklet.addModule(processorURL)
        const {engineModule, deviceModules, deviceBoxTypes} = await loadEngineModules()
        const memory = createEngineMemory()
        const workletNode = new AudioWorkletNode(ctx, "engine", {
            outputChannelCount: [2], // STEREO out; without this the node defaults to mono and drops the right channel
            processorOptions: {engineModule, deviceModules, deviceBoxTypes, memory, sampleRate: ctx.sampleRate, metronome: options.metronome ?? false}
        })
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        // ONE Messenger over the worklet port, split into typed Communicator protocols, one per named channel:
        // `engine` sends the SyncSource transaction bytes (this side dispatches), `transport` receives the
        // back-channel (this side executes), `samples` is the sample-load RPC (this side executes). (The worklet
        // also emits a `heap` channel, observed only by the metronome page.)
        const messenger = Messenger.for(workletNode.port)
        lifecycle.own(messenger)
        const engine = Communicator.sender<EngineProtocol>(messenger.channel("engine"), dispatcher => new class implements EngineProtocol {
            applyUpdates(bytes: ArrayBuffer): void {dispatcher.dispatchAndForget(this.applyUpdates, Communicator.makeTransferable(bytes))}
        })
        lifecycle.own(Communicator.executor<TransportListener>(messenger.channel("transport"), new class implements TransportListener {
            state(bytes: ArrayBuffer): void {showState(bytes)}
        }))
        // Route F: the sample loader. The worklet drives the handshake; this executor fetches + decodes a sample
        // and writes its PLANAR frames into the SAB at the engine-allocated pointer.
        const held = new Map<string, AudioData>()
        const sampleLoader: SampleLoader = new class implements SampleLoader {
            async decode(uuid: UUID.Bytes): Promise<SampleInfo> {
                const data = await loadSample(uuid)
                held.set(UUID.toString(uuid), data)
                return {
                    byteLength: data.numberOfFrames * data.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
                    frameCount: data.numberOfFrames,
                    channelCount: data.numberOfChannels,
                    sampleRate: data.sampleRate
                }
            }
            async write(uuid: UUID.Bytes, pointer: number): Promise<void> {
                const key = UUID.toString(uuid)
                const data = asDefined(held.get(key), "sample not decoded")
                const frames = data.numberOfFrames
                for (let channel = 0; channel < data.numberOfChannels; channel++) {
                    const offset = pointer + channel * frames * Float32Array.BYTES_PER_ELEMENT
                    new Float32Array(memory.buffer, offset, frames).set(data.frames[channel])
                }
                held.delete(key)
            }
        }
        lifecycle.own(Communicator.executor<SampleLoader>(messenger.channel("samples"), sampleLoader))
        // SyncSource (unchanged) -> local BroadcastChannel loopback -> serialize (this graph's schema) -> worklet bytes.
        const sender = new BroadcastChannel(options.channel)
        const receiver = new BroadcastChannel(options.channel)
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates(tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void {
                const bytes = serializeUpdateTasks(tasks, boxGraph)
                engine.applyUpdates(bytes)
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
