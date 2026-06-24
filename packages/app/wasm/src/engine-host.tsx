import {createElement} from "@opendaw/lib-jsx"
import {asDefined, ByteArrayInput, Lifecycle, MutableObservableOption, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Synchronization, SyncSource, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {EngineStateSchema, ProjectSkeleton} from "@opendaw/studio-adapters"
import {AudioData, PPQN} from "@opendaw/lib-dsp"
import {SampleInfo, SampleLoader} from "./sample-loader"
import {EngineProtocol, HeapListener, HeapStats, TransportListener} from "./engine-protocol"
import {loadSample} from "./sample-fetch"
import {serializeUpdateTasks} from "./sync/serialize-update-tasks"
import {createEngineMemory, loadEngineModules} from "./engine-modules"
import processorURL from "./engine-processor.ts?worker&url"

// The box graph type ProjectSkeleton hands back; every page drives the engine from one of these.
type EngineBoxGraph = ReturnType<typeof ProjectSkeleton.empty>["boxGraph"]

/// The shared engine host every page mounts: it boots the AudioWorklet engine, loads the device modules,
/// streams the page's box graph into it through the unchanged `SyncSource`, and decodes the engine-state and
/// heap back-channels. Pages drop `{host.element}` at the top (the Resume / Suspend AudioContext buttons, the
/// engine-state grid, and the heap grid) and `{host.log}` at the bottom, identically across every page. The
/// boot, sync wiring, and teardown live here once instead of being copy-pasted per page.
export interface EngineHost {
    readonly element: HTMLElement // the HUD panel: transport buttons + state grid + heap grid
    readonly log: HTMLPreElement  // the scrolling boot / sample log, rendered at the bottom of the page
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
    const log: HTMLPreElement = <pre className="engine-log"/>
    const append = (line: string): void => {log.textContent = `${log.textContent ?? ""}${line}\n`}
    const led: HTMLSpanElement = <span className="engine-led"/>
    // Each metric is its own right-aligned value cell so a changing digit count cannot shift the layout; cells
    // start as a dash and stay dashed until the back-channel delivers a real value.
    const audioStateValue: HTMLSpanElement = <span className="value">—</span>
    const transportValue: HTMLSpanElement = <span className="value">—</span>
    const positionValue: HTMLSpanElement = <span className="value">—</span>
    const beatValue: HTMLSpanElement = <span className="value">—</span>
    const tempoValue: HTMLSpanElement = <span className="value">—</span>
    const heapUsedValue: HTMLSpanElement = <span className="value">—</span>
    const heapClaimedValue: HTMLSpanElement = <span className="value">—</span>
    const memoryTotalValue: HTMLSpanElement = <span className="value">—</span>
    const metric = (label: string, value: HTMLElement, unit: string = ""): ReadonlyArray<HTMLElement> =>
        [<span className="label">{label}</span>, value, <span className="unit">{unit}</span>]
    const stateIO = EngineStateSchema()
    const showState = (bytes: ArrayBuffer): void => {
        stateIO.read(new ByteArrayInput(bytes))
        const {position, bpm, isPlaying} = stateIO.object
        positionValue.textContent = position.toFixed(0)
        beatValue.textContent = (position / PPQN.Quarter + 1).toFixed(2)
        tempoValue.textContent = bpm.toFixed(1)
        transportValue.textContent = isPlaying ? "playing" : "stopped"
    }
    const kb = (bytes: number): string => (bytes / 1024).toFixed(1)
    const showMemory = ({heapUsed, heapClaimed, memoryTotal}: HeapStats): void => {
        heapUsedValue.textContent = kb(heapUsed)
        heapClaimedValue.textContent = kb(heapClaimed)
        memoryTotalValue.textContent = kb(memoryTotal)
    }
    // The transport buttons actually toggle the AudioContext (suspend / resume), so they are labelled and gated
    // by its real state: nothing to resume before boot, no double-resume while running.
    const resumeButton: HTMLButtonElement = <button onclick={() => void play()}>Resume</button>
    const suspendButton: HTMLButtonElement = <button onclick={() => void stop()}>Suspend</button>
    const showAudioState = (): void => {
        if (!context.nonEmpty()) {
            audioStateValue.textContent = "—"
            resumeButton.disabled = true
            suspendButton.disabled = true
            return
        }
        const {state} = context.unwrap()
        audioStateValue.textContent = state
        audioStateValue.classList.toggle("on", state === "running")
        led.classList.toggle("on", state === "running")
        resumeButton.disabled = state === "running"
        suspendButton.disabled = state !== "running"
    }
    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        ctx.addEventListener("statechange", () => showAudioState())
        showAudioState()
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
        lifecycle.own(Communicator.executor<HeapListener>(messenger.channel("heap"), new class implements HeapListener {
            heap(stats: HeapStats): void {showMemory(stats)}
        }))
        // Route F: the sample loader. The worklet drives the handshake; this executor fetches + decodes a sample
        // and writes its PLANAR frames into the SAB at the engine-allocated pointer.
        const held = new Map<string, AudioData>()
        const sampleLoader: SampleLoader = new class implements SampleLoader {
            async decode(uuid: UUID.Bytes): Promise<SampleInfo> {
                const id = UUID.toString(uuid)
                append(`sample ${id}: requesting…`)
                try {
                    const data = await loadSample(uuid)
                    held.set(id, data)
                    append(`sample ${id}: decoded ${data.numberOfFrames} frames, ${data.numberOfChannels}ch @ ${data.sampleRate} Hz`)
                    return {
                        byteLength: data.numberOfFrames * data.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
                        frameCount: data.numberOfFrames,
                        channelCount: data.numberOfChannels,
                        sampleRate: data.sampleRate
                    }
                } catch (error) {
                    append(`sample ${id}: FAILED ${error instanceof Error ? error.message : String(error)}`)
                    throw error
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
                append(`sample ${key}: written @ ptr ${pointer} (${frames * data.numberOfChannels * Float32Array.BYTES_PER_ELEMENT} bytes)`)
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
        if (context.nonEmpty()) {await context.unwrap().resume()}
    }
    const stop = async (): Promise<void> => {
        if (context.nonEmpty()) {await context.unwrap().suspend()}
    }
    lifecycle.own({
        terminate: () => {
            node.ifSome(workletNode => workletNode.disconnect())
            context.ifSome(ctx => void ctx.close())
        }
    })
    const element: HTMLElement = (
        <div className="engine-panel">
            <div className="engine-transport">
                <div className="engine-id">{led}<span className="engine-title">Engine</span></div>
                <div className="engine-buttons">{resumeButton}{suspendButton}</div>
            </div>
            <div className="engine-readout">
                <div className="engine-grid">
                    {metric("Audio", audioStateValue)}
                    {metric("Transport", transportValue)}
                    {metric("Position", positionValue, "pulses")}
                    {metric("Beat", beatValue)}
                    {metric("Tempo", tempoValue, "bpm")}
                </div>
                <div className="engine-grid">
                    {metric("Heap used", heapUsedValue, "KB")}
                    {metric("Heap claimed", heapClaimedValue, "KB")}
                    {metric("Linear memory", memoryTotalValue, "KB")}
                </div>
            </div>
        </div>
    )
    showAudioState()
    void boot()
    return {element, log, append, play, stop}
}
