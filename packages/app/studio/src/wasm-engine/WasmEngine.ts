// Main-thread side of the WASM engine toggle: loads + caches the engine/device wasm modules, registers the
// worklet processor module once, and installs the EngineVariant provider the studio-core EngineWorklet
// consults at construction. The selection persists in localStorage; every engine (re)boot re-reads it, so
// the existing restart machinery swaps engines without a page reload.
import {MutableObservableOption, Nullable, Terminable} from "@opendaw/lib-std"
import {Communicator, Messenger, Promises} from "@opendaw/lib-runtime"
import {Synchronization, SyncSource, UpdateTask} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {EngineVariant, EngineWorkletVariant, OfflineEngineRenderer, Project} from "@opendaw/studio-core"
import {createEngineMemory, EngineModules, loadEngineModules} from "../../../wasm/src/engine-modules"
import {serializeUpdateTasks} from "../../../wasm/src/sync/serialize-update-tasks"
import {WASM_ENGINE_PROCESSOR_NAME, WASM_SYNC_CHANNEL, WasmEngineAttachment, WasmSyncProtocol} from "./protocol"
import processorUrl from "./processor.ts?worker&url"
import offlineWorkerUrl from "./offline-worker.ts?worker&url"

export namespace WasmEngine {
    const FLAG_KEY = "opendaw-wasm-engine"
    const modules = new MutableObservableOption<EngineModules>()

    export const isEnabled = (): boolean => localStorage.getItem(FLAG_KEY) === "true"

    export const setEnabled = (enabled: boolean): void => localStorage.setItem(FLAG_KEY, String(enabled))

    // Compile the wasm modules + register the processor module (both once). Returns false when the engine
    // artifacts are unavailable (e.g. a deploy without them), so callers can revert to the TS engine.
    export const ensureReady = async (context: BaseAudioContext): Promise<boolean> => {
        if (modules.nonEmpty()) {return true}
        const {status, value, error} = await Promises.tryCatch((async () => {
            await context.audioWorklet.addModule(processorUrl)
            return loadEngineModules(`${import.meta.env.BASE_URL}wasm-engine`)
        })())
        if (status === "rejected") {
            console.warn("WASM engine unavailable:", error)
            return false
        }
        modules.wrap(value)
        return true
    }

    export const install = (): void => {
        // The OFFLINE render path (device benchmarks, offline parity renders): the worker self-loads the
        // wasm artifacts, so no preloading is needed here.
        OfflineEngineRenderer.installVariant(offlineWorkerUrl, {wasmUrl: `${import.meta.env.BASE_URL}wasm-engine`})
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
                connectSync: (messenger: Messenger, project: Project): Terminable => connectSync(messenger, project)
            }
        })
    }

    // SyncSource (unchanged) -> local MessageChannel loopback -> serialize (the source graph's schema, so it
    // must run here on the main thread) -> transaction bytes to the worklet's apply_updates. The `true` flag
    // makes SyncSource open with a full dump of the graph, which is how the engine receives the project.
    const connectSync = (messenger: Messenger, project: Project): Terminable => {
        const sender = Communicator.sender<WasmSyncProtocol>(messenger.channel(WASM_SYNC_CHANNEL),
            dispatcher => new class implements WasmSyncProtocol {
                applyUpdates(bytes: ArrayBuffer): void {
                    dispatcher.dispatchAndForget(this.applyUpdates, Communicator.makeTransferable(bytes))
                }
            })
        const target: Synchronization<BoxIO.TypeMap> = {
            sendUpdates: (tasks: ReadonlyArray<UpdateTask<BoxIO.TypeMap>>): void =>
                sender.applyUpdates(serializeUpdateTasks(tasks, project.boxGraph)),
            checksum: (_value: Int8Array): Promise<void> => Promise.resolve()
        }
        const channel = new MessageChannel()
        const executor = Communicator.executor<Synchronization<BoxIO.TypeMap>>(Messenger.for(channel.port2), target)
        const syncSource = new SyncSource<BoxIO.TypeMap>(project.boxGraph, Messenger.for(channel.port1), true)
        channel.port1.start()
        channel.port2.start()
        return {
            terminate: () => {
                syncSource.terminate()
                executor.terminate()
                channel.port1.close()
                channel.port2.close()
            }
        }
    }
}
