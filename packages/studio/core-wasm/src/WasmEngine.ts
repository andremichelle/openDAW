// Main-thread API of the WASM engine: `install` takes the host-served URLs (the prebuilt worklet module,
// the prebuilt offline render worker, and the base serving the wasm binaries — all shipped in this
// package's dist), registers the EngineVariant provider the studio-core EngineWorklet consults at
// construction, and wires the offline render variant. `prepare` (and its boolean form `ensureReady`) compiles the
// modules once and registers the processor module on each AudioContext it is given.
import {isDefined, MutableObservableOption, Terminable} from "@opendaw/lib-std"
import {Communicator, Messenger, Promises} from "@opendaw/lib-runtime"
import {Synchronization, SyncSource, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {EngineVariant, EngineWorkletVariant, OfflineEngineRenderer, Project} from "@opendaw/studio-core"
import {EngineModules, loadEngineModules} from "./engine-modules"
import {serializeUpdateTasks} from "./sync/serialize-update-tasks"
import {createSyncLoopback} from "./sync/loopback"
import {
    WASM_ENGINE_PROCESSOR_NAME,
    WASM_SYNC_CHANNEL,
    WasmEngineAttachment,
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
    const modules = new MutableObservableOption<EngineModules>()
    const config = new MutableObservableOption<WasmEngineUrls>()
    const registrations = new WeakMap<BaseAudioContext, Promise<void>>()

    // Whether the wasm modules are compiled. Each AudioContext still needs its own `prepare` / `ensureReady`.
    export const isReady = (): boolean => modules.nonEmpty()

    // A rejected registration is dropped, so the next call retries it.
    const register = (context: BaseAudioContext, processorUrl: string): Promise<void> => {
        const existing = registrations.get(context)
        if (isDefined(existing)) {return existing}
        const registration = context.audioWorklet.addModule(processorUrl)
        registrations.set(context, registration)
        registration.catch(() => registrations.delete(context))
        return registration
    }

    // Rejects with the error that kept the engine from loading.
    export const prepare = async (context: BaseAudioContext): Promise<void> => {
        const {processorUrl, wasmUrl} = config.unwrap("WasmEngine.install must run before prepare")
        await register(context, processorUrl)
        if (modules.isEmpty()) {modules.wrap(await loadEngineModules(wasmUrl))}
    }

    // `prepare` as a boolean: false when the engine cannot load.
    export const ensureReady = async (context: BaseAudioContext): Promise<boolean> => {
        config.assert("WasmEngine.install must run before ensureReady")
        const {status, error} = await Promises.tryCatch(prepare(context))
        if (status === "rejected") {
            console.warn("WASM engine unavailable:", error)
            return false
        }
        return true
    }

    export const install = (urls: WasmEngineUrls): void => {
        config.wrap(urls)
        // The OFFLINE render path (mixdown/stems/freeze/benchmarks): the worker self-loads the wasm
        // artifacts from `wasmUrl`, so no preloading is needed here.
        OfflineEngineRenderer.install(urls.offlineWorkerUrl, {wasmUrl: urls.wasmUrl})
        EngineVariant.install((): EngineWorkletVariant => {
            const {engineModule, deviceModules, deviceBoxTypes, composites, effectComposites} =
                modules.unwrap("WasmEngine.ensureReady must succeed before an engine boots")
            const attachment: WasmEngineAttachment =
                {engineModule, deviceModules, deviceBoxTypes, composites, effectComposites}
            return {
                processorName: WASM_ENGINE_PROCESSOR_NAME,
                attachment,
                connectSync: (messenger: Messenger, project: Project): Terminable => connectSync(messenger, project)
                // No connectFrozenAudio: the memory is worklet-owned (non-shared), so frozen PCM travels
                // through the `setFrozenAudio` engine command and is copied worklet-side.
            }
        })
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
