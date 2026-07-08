// Main-thread API of the WASM engine: `install` takes the host-served URLs (the prebuilt worklet module,
// the prebuilt offline render worker, and the base serving the wasm binaries — all shipped in this
// package's dist), registers the EngineVariant provider the studio-core EngineWorklet consults at
// construction, and wires the offline render variant. `ensureReady` compiles the modules + registers the
// processor module once. The WASM engine is the DEFAULT; localStorage only records an explicit opt-out.
// Every engine (re)boot re-reads it, so the existing restart machinery swaps engines without a page reload.
import {isNull, MutableObservableOption, Nullable, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"
import {Communicator, Messenger, Promises} from "@opendaw/lib-runtime"
import {Synchronization, SyncSource, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {EngineVariant, EngineWorkletVariant, FrozenAudioWriter, OfflineEngineRenderer, Project} from "@opendaw/studio-core"
import {createEngineMemory, EngineModules, loadEngineModules} from "./engine-modules"
import {serializeUpdateTasks} from "./sync/serialize-update-tasks"
import {createSyncLoopback} from "./sync/loopback"
import {
    WASM_ENGINE_PROCESSOR_NAME,
    WASM_FROZEN_CHANNEL,
    WASM_SYNC_CHANNEL,
    WasmEngineAttachment,
    WasmFrozenProtocol,
    WasmSyncProtocol
} from "./protocol"
export type WasmEngineUrls = {
    // The prebuilt realtime worklet module (this package's dist/wasm-processor.js), served by the host.
    processorUrl: string
    // The prebuilt offline render worker (dist/wasm-offline-worker.js), served by the host.
    offlineWorkerUrl: string
    // Base URL serving the binaries (dist/wasm/*): `${wasmUrl}/wasm/engine.wasm` + `${wasmUrl}/wasm/plugins/*.wasm`.
    wasmUrl: string
}

export namespace WasmEngine {
    const FLAG_KEY = "opendaw-wasm-engine"
    const modules = new MutableObservableOption<EngineModules>()
    const config = new MutableObservableOption<WasmEngineUrls>()

    export const isEnabled = (): boolean => localStorage.getItem(FLAG_KEY) !== "false"

    export const setEnabled = (enabled: boolean): void => localStorage.setItem(FLAG_KEY, String(enabled))

    // Whether the wasm modules are compiled and the processor is registered (i.e. `ensureReady` succeeded).
    export const isReady = (): boolean => modules.nonEmpty()

    // Whether an offline render (mixdown, stems, publish, video audio) should run through the wasm variant:
    // the engine is enabled, its artifacts actually loaded, and the offline worker is installed.
    export const useForExports = (): boolean => isEnabled() && isReady() && OfflineEngineRenderer.hasVariant()

    // Compile the wasm modules + register the processor module (both once). Returns false when the engine
    // artifacts are unavailable (e.g. a deploy without them), so callers can revert to the TS engine.
    export const ensureReady = async (context: BaseAudioContext): Promise<boolean> => {
        if (modules.nonEmpty()) {return true}
        const {processorUrl, wasmUrl} = config.unwrap("WasmEngine.install must run before ensureReady")
        const {status, value, error} = await Promises.tryCatch((async () => {
            await context.audioWorklet.addModule(processorUrl)
            return loadEngineModules(wasmUrl)
        })())
        if (status === "rejected") {
            console.warn("WASM engine unavailable:", error)
            return false
        }
        modules.wrap(value)
        return true
    }

    export const install = (urls: WasmEngineUrls): void => {
        config.wrap(urls)
        // The OFFLINE render path (mixdown/stems/freeze/benchmarks): the worker self-loads the wasm
        // artifacts from `wasmUrl`, so no preloading is needed here.
        OfflineEngineRenderer.installVariant(urls.offlineWorkerUrl, {wasmUrl: urls.wasmUrl})
        OfflineEngineRenderer.installVariantPolicy(() => useForExports()) // freeze/consolidation follow the toggle
        EngineVariant.install((): Nullable<EngineWorkletVariant> => {
            if (!isEnabled() || modules.isEmpty()) {return null}
            const {engineModule, deviceModules, deviceBoxTypes, composites} = modules.unwrap()
            const attachment: WasmEngineAttachment = {
                // A FRESH shared memory per boot: re-instantiating the engine re-applies its data segments,
                // but a recycled heap would leak every allocation of the previous engine instance.
                engineModule, deviceModules, deviceBoxTypes, composites, memory: createEngineMemory()
            }
            return {
                processorName: WASM_ENGINE_PROCESSOR_NAME,
                attachment,
                connectSync: (messenger: Messenger, project: Project): Terminable => connectSync(messenger, project),
                connectFrozenAudio: (messenger: Messenger): FrozenAudioWriter =>
                    connectFrozenAudio(messenger, attachment.memory)
            }
        })
    }

    // Freeze PCM delivery: the worklet only ALLOCATES (a small RPC returning the engine's planar stereo
    // pointer) and ATTACHES — the bulk copy runs here on the MAIN thread, straight into the shared engine
    // memory. Operations chain sequentially: a second freeze reallocates `frozen_pending`, so no write may
    // start while another is between allocate and attach (the engine reboot replay sends several at once).
    // The worklet may memory.grow inside `frozen_allocate`, which leaves previously obtained buffer
    // references stale (they keep their pre-grow length), so the buffer is re-read after the RPC returns.
    const connectFrozenAudio = (messenger: Messenger, memory: WebAssembly.Memory): FrozenAudioWriter => {
        const sender = Communicator.sender<WasmFrozenProtocol>(messenger.channel(WASM_FROZEN_CHANNEL),
            dispatcher => new class implements WasmFrozenProtocol {
                frozenAllocate(frameCount: number, channels: number): Promise<number> {
                    return dispatcher.dispatchAndReturn(this.frozenAllocate, frameCount, channels)
                }
                frozenAttach(uuid: UUID.Bytes, frameCount: number, channels: number, sampleRate: number): void {
                    dispatcher.dispatchAndForget(this.frozenAttach, uuid, frameCount, channels, sampleRate)
                }
                frozenClear(uuid: UUID.Bytes): void {dispatcher.dispatchAndForget(this.frozenClear, uuid)}
            })
        const queue = {tail: Promise.resolve()}
        return (uuid: UUID.Bytes, audioData: Nullable<AudioData>): void => {
            queue.tail = queue.tail.then(() => {
                if (isNull(audioData)) {
                    sender.frozenClear(uuid)
                    return
                }
                const {frames, numberOfFrames, numberOfChannels, sampleRate} = audioData
                const channels = Math.min(numberOfChannels, 2)
                return sender.frozenAllocate(numberOfFrames, channels).then(pointer => {
                    if (pointer === 0) {return}
                    const buffer = memory.buffer
                    for (let channel = 0; channel < channels; channel++) {
                        new Float32Array(buffer,
                            pointer + channel * numberOfFrames * Float32Array.BYTES_PER_ELEMENT, numberOfFrames)
                            .set(frames[channel])
                    }
                    sender.frozenAttach(uuid, numberOfFrames, channels, sampleRate)
                })
            }).catch(reason => console.warn("frozen audio delivery failed:", reason))
        }
    }

    // SyncSource (unchanged) -> SYNCHRONOUS loopback -> serialize at emission time (the source graph's
    // schema AND state — a MessageChannel hop would let a later transaction delete boxes before the batch
    // resolves its primitive codecs) -> transaction bytes to the worklet's apply_updates. The `true` flag
    // makes SyncSource open with a full dump of the graph, which is how the engine receives the project.
    // A throttled checksum round-trip follows the batches on the same ordered channel: the worklet compares
    // the source checksum against the engine's rolling checksum and escalates a divergence.
    const CHECKSUM_INTERVAL_MS = 1_000
    const connectSync = (messenger: Messenger, project: Project): Terminable => {
        const sender = Communicator.sender<WasmSyncProtocol>(messenger.channel(WASM_SYNC_CHANNEL),
            dispatcher => new class implements WasmSyncProtocol {
                applyUpdates(bytes: ArrayBuffer): void {
                    dispatcher.dispatchAndForget(this.applyUpdates, Communicator.makeTransferable(bytes))
                }
                checksum(bytes: Int8Array): Promise<void> {
                    return dispatcher.dispatchAndReturn(this.checksum, bytes)
                }
            })
        const throttle = {next: 0}
        const verifyChecksum = (): void => {
            const now = performance.now()
            if (now < throttle.next) {return}
            throttle.next = now + CHECKSUM_INTERVAL_MS
            sender.checksum(project.boxGraph.checksum())
                .catch(reason => console.warn("wasm engine checksum verification failed:", reason))
        }
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates: (tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void => {
                sender.applyUpdates(serializeUpdateTasks(tasks))
                verifyChecksum()
            },
            checksum: (value: Int8Array): Promise<void> => sender.checksum(value)
        }
        const loopback = createSyncLoopback()
        const executor = Communicator.executor<Synchronization<BoxIO.TypeMap>>(loopback.target, target)
        const syncSource = new SyncSource<BoxIO.TypeMap>(project.boxGraph, loopback.source, true)
        return {
            terminate: () => {
                syncSource.terminate()
                executor.terminate()
                loopback.terminate()
            }
        }
    }
}
