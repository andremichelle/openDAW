import {createElement} from "@opendaw/lib-jsx"
import {asDefined, ByteArrayInput, Lifecycle, MutableObservableOption, Procedure, UUID} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {Synchronization, SyncSource, UpdateTask} from "@opendaw/lib-box"
import {ApparatDeviceBox, BoxIO, SpielwerkDeviceBox, WerkstattDeviceBox} from "@opendaw/studio-boxes"
import {EngineStateSchema, ProjectSkeleton, ScriptCompiler} from "@opendaw/studio-adapters"
import {AudioData, PPQN} from "@opendaw/lib-dsp"
import {SampleInfo, SampleLoader} from "./sample-loader"
import {SoundfontInfo, SoundfontLoader} from "./soundfont-loader"
import {NamLoader} from "./nam-loader"
import {loadSoundfontBlob} from "./soundfont-fetch"
import {EngineProtocol, HeapListener, HeapStats, ScriptListener, TransportListener} from "./engine-protocol"
import {loadSampleCached} from "./sample-fetch"
import {serializeUpdateTasks} from "./sync/serialize-update-tasks"
import {createEngineMemory, loadEngineModules} from "./engine-modules"
import processorURL from "./engine-processor.ts?worker&url"

// The box graph type ProjectSkeleton hands back; every page drives the engine from one of these.
type EngineBoxGraph = ReturnType<typeof ProjectSkeleton.empty>["boxGraph"]

// Register every scriptable device's user script (Werkstatt / Apparat / Spielwerk) into THIS context's
// AudioWorkletGlobalScope — the same scope the engine processor runs in — so the engine's `ScriptBridges` find
// them at `globalThis.openDAW.<registry>[uuid]`. Mirrors the studio's `Project.loadScriptDevices`: without it a
// loaded scriptable device has no registered `Processor`, so its bridge stays silent (no audio). Each `load`
// parses the box's `code`, wraps it, and `audioWorklet.addModule`s the blob; must complete before play.
const loadScriptDevices = async (audioContext: BaseAudioContext, boxGraph: EngineBoxGraph,
                                 append: (line: string) => void): Promise<void> => {
    const load = (config: ScriptCompiler.Config, box: ScriptCompiler.ScriptDeviceBox): Promise<void> =>
        ScriptCompiler.create(config).load(audioContext, box).then(
            () => append(`script ${UUID.toString(box.address.uuid)}: registered (${config.headerTag})`),
            (reason: unknown) => append(`script ${UUID.toString(box.address.uuid)}: FAILED ${reason}`))
    const pending: Array<Promise<void>> = []
    for (const box of boxGraph.boxes()) {
        if (box instanceof ApparatDeviceBox) {
            pending.push(load({headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"}, box))
        } else if (box instanceof WerkstattDeviceBox) {
            pending.push(load({headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"}, box))
        } else if (box instanceof SpielwerkDeviceBox) {
            pending.push(load({headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"}, box))
        }
    }
    await Promise.all(pending)
}

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
    pause(): Promise<void>
    stop(): Promise<void>
}

export interface EngineHostOptions {
    readonly channel: string      // a BroadcastChannel name unique to the page (the SyncSource loopback)
    readonly metronome?: boolean  // the engine's built-in metronome click (default off)
    // Called with the worklet-port Messenger once it exists, so a page can attach its own channels (e.g. a
    // `LiveStreamReceiver` on "engine-live-data") next to the host's transport / heap / sample protocols.
    readonly onMessenger?: Procedure<Messenger>
}

export const createEngineHost = (boxGraph: EngineBoxGraph, lifecycle: Lifecycle, options: EngineHostOptions): EngineHost => {
    const context = new MutableObservableOption<AudioContext>()
    const engineRef = new MutableObservableOption<EngineProtocol>()
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
        playButton.disabled = isPlaying
        pauseButton.disabled = !isPlaying
    }
    const kb = (bytes: number): string => (bytes / 1024).toFixed(1)
    const showMemory = ({heapUsed, heapClaimed, memoryTotal}: HeapStats): void => {
        heapUsedValue.textContent = kb(heapUsed)
        heapClaimedValue.textContent = kb(heapClaimed)
        memoryTotalValue.textContent = kb(memoryTotal)
    }
    // Real transport controls. Play also resumes the AudioContext (so the first Play un-suspends the audio),
    // Pause freezes the position, Stop rewinds and resets every plugin + clears the buffers.
    const playButton: HTMLButtonElement = <button onclick={() => void play()}>Play</button>
    const pauseButton: HTMLButtonElement = <button onclick={() => void pause()}>Pause</button>
    const stopButton: HTMLButtonElement = <button onclick={() => void stop()}>Stop</button>
    const showAudioState = (): void => {
        if (!context.nonEmpty()) {
            audioStateValue.textContent = "—"
            return
        }
        const {state} = context.unwrap()
        audioStateValue.textContent = state
        audioStateValue.classList.toggle("on", state === "running")
        led.classList.toggle("on", state === "running")
    }
    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        ctx.addEventListener("statechange", () => showAudioState())
        showAudioState()
        await ctx.audioWorklet.addModule(processorURL)
        // Register the project's scriptable-device user scripts into this same worklet scope BEFORE the engine
        // starts rendering, so their bridges find a Processor at globalThis.openDAW.<registry>[uuid].
        await loadScriptDevices(ctx, boxGraph, append)
        const {engineModule, deviceModules, deviceBoxTypes, composites} = await loadEngineModules()
        const memory = createEngineMemory()
        const workletNode = new AudioWorkletNode(ctx, "engine", {
            outputChannelCount: [2], // STEREO out; without this the node defaults to mono and drops the right channel
            processorOptions: {engineModule, deviceModules, deviceBoxTypes, composites, memory, sampleRate: ctx.sampleRate, metronome: options.metronome ?? false}
        })
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        // ONE Messenger over the worklet port, split into typed Communicator protocols, one per named channel:
        // `engine` sends the SyncSource transaction bytes (this side dispatches), `transport` receives the
        // back-channel (this side executes), `samples` is the sample-load RPC (this side executes). (The worklet
        // also emits a `heap` channel, observed only by the metronome page.)
        const messenger = Messenger.for(workletNode.port)
        lifecycle.own(messenger)
        options.onMessenger?.(messenger)
        const engine = Communicator.sender<EngineProtocol>(messenger.channel("engine"), dispatcher => new class implements EngineProtocol {
            applyUpdates(bytes: ArrayBuffer): void {dispatcher.dispatchAndForget(this.applyUpdates, Communicator.makeTransferable(bytes))}
            play(): void {dispatcher.dispatchAndForget(this.play)}
            pause(): void {dispatcher.dispatchAndForget(this.pause)}
            stop(): void {dispatcher.dispatchAndForget(this.stop)}
        })
        engineRef.wrap(engine)
        lifecycle.own(Communicator.executor<TransportListener>(messenger.channel("transport"), new class implements TransportListener {
            state(bytes: ArrayBuffer): void {showState(bytes)}
        }))
        lifecycle.own(Communicator.executor<HeapListener>(messenger.channel("heap"), new class implements HeapListener {
            heap(stats: HeapStats): void {showMemory(stats)}
        }))
        // A scriptable device reporting a user-script runtime / validation error (it silences itself in the engine).
        lifecycle.own(Communicator.executor<ScriptListener>(messenger.channel("script"), new class implements ScriptListener {
            deviceMessage(uuid: string, message: string): void {append(`script ${uuid}: ${message}`)}
        }))
        // Route F: the sample loader. The worklet drives the handshake; this executor fetches + decodes a sample
        // and writes its PLANAR frames into the SAB at the engine-allocated pointer.
        const held = new Map<string, AudioData>()
        const sampleLoader: SampleLoader = new class implements SampleLoader {
            async decode(uuid: UUID.Bytes): Promise<SampleInfo> {
                const id = UUID.toString(uuid)
                append(`sample ${id}: requesting…`)
                try {
                    const data = await loadSampleCached(uuid)
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
        // The soundfont analog: fetch + parse the .sf2 on the main thread, build the simplified blob, and write
        // it into the engine allocation. The wasm side only ever sees the blob.
        const heldSoundfonts = new Map<string, Uint8Array>()
        const soundfontLoader: SoundfontLoader = new class implements SoundfontLoader {
            async decode(uuid: UUID.Bytes): Promise<SoundfontInfo> {
                const id = UUID.toString(uuid)
                append(`soundfont ${id}: requesting…`)
                try {
                    const blob = new Uint8Array(await loadSoundfontBlob(uuid))
                    heldSoundfonts.set(id, blob)
                    append(`soundfont ${id}: built ${blob.byteLength} bytes`)
                    return {byteLength: blob.byteLength}
                } catch (error) {
                    append(`soundfont ${id}: FAILED ${error instanceof Error ? error.message : String(error)}`)
                    throw error
                }
            }
            async write(uuid: UUID.Bytes, pointer: number): Promise<void> {
                const key = UUID.toString(uuid)
                const blob = asDefined(heldSoundfonts.get(key), "soundfont not built")
                new Uint8Array(memory.buffer, pointer, blob.byteLength).set(blob)
                append(`soundfont ${key}: written @ ptr ${pointer} (${blob.byteLength} bytes)`)
                heldSoundfonts.delete(key)
            }
        }
        lifecycle.own(Communicator.executor<SoundfontLoader>(messenger.channel("soundfonts"), soundfontLoader))
        // The NAM analog: fetch the `@opendaw/nam-wasm` binary (lazily, on the worklet's first NeuralAmp model
        // load) and hand the bytes over; the worklet instantiates it next to the engine. The TS engine's recipe.
        lifecycle.own(Communicator.executor<NamLoader>(messenger.channel("nam"), new class implements NamLoader {
            async fetchWasm(): Promise<ArrayBuffer> {
                const url = new URL("@opendaw/nam-wasm/nam.wasm", import.meta.url)
                append(`nam: fetching ${url}`)
                return (await fetch(url)).arrayBuffer()
            }
        }))
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
    // Real transport. `play` also resumes the AudioContext (browsers start it suspended, needing a gesture);
    // `pause` / `stop` leave the audio running so playback can resume instantly. `stop` rewinds + resets plugins.
    const play = async (): Promise<void> => {
        if (context.nonEmpty()) {await context.unwrap().resume()}
        engineRef.ifSome(engine => engine.play())
    }
    const pause = async (): Promise<void> => {
        engineRef.ifSome(engine => engine.pause())
    }
    const stop = async (): Promise<void> => {
        engineRef.ifSome(engine => engine.stop())
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
                <div className="engine-buttons">{playButton}{pauseButton}{stopButton}</div>
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
    return {element, log, append, play, pause, stop}
}
