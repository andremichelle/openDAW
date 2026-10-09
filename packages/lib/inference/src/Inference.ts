import {
    asDefined,
    EmptyExec,
    isAbsent,
    isDefined,
    Option,
    panic,
    Procedure,
    Provider,
    Terminable,
    unitValue
} from "@opendaw/lib-std"
import {ExecutionProvider, ModelDescriptor, TaskDefinition} from "./Task"
import {TaskInput, TaskKey, TaskOutput, TaskRegistry} from "./registry"
import {InferenceConfig, installInferenceConfig, requireInferenceConfig} from "./InferenceConfig"
import {EngineHost, runTask} from "./EngineHost"
import {InferenceEngineError} from "./Errors"
import {ModelStore} from "./ModelStore"

export interface RunOptions {
    readonly progress?: Procedure<unitValue>
    readonly signal?: AbortSignal
    readonly executionProvider?: ExecutionProvider | "auto"
    /**
     * Fraction of overall progress mapped to the download / session-load
     * phase. Default 0.5. Set to 0 after a successful `Inference.preload`
     * so the progress callback receives only the inference portion.
     */
    readonly downloadShare?: number
}

export interface PreloadOptions {
    readonly progress?: Procedure<unitValue>
    readonly signal?: AbortSignal
    readonly executionProvider?: ExecutionProvider | "auto"
}

export interface AcquireOptions {
    readonly executionProvider?: ExecutionProvider | "auto"
}

export interface TaskHandle<K extends TaskKey> extends Terminable {
    run(input: TaskInput<K>, options?: RunOptions): Promise<TaskOutput<K>>
}

export interface InstallOptions extends InferenceConfig {
    readonly workerFactory?: Provider<Worker>
}

let host: Option<EngineHost> = Option.None

const defaultWorkerFactory: Provider<Worker> = () => new Worker(
    new URL("./workers/inference.worker.js", import.meta.url),
    {type: "module", name: "opendaw-inference"}
)

const requireHost = (): EngineHost => host.match({
    none: () => panic("Inference is not installed. Call Inference.install({opfs}) at startup."),
    some: instance => instance
})

const resolveProviders = (
    available: ReadonlyArray<ExecutionProvider>,
    requested: ExecutionProvider | "auto" | undefined
): ReadonlyArray<ExecutionProvider> => {
    if (isAbsent(requested) || requested === "auto") {return available}
    return [requested]
}

const lookupTask = <K extends TaskKey>(key: K): TaskDefinition<TaskInput<K>, TaskOutput<K>> => {
    const task = asDefined(
        (TaskRegistry as Readonly<Record<string, TaskDefinition<unknown, unknown>>>)[key as string],
        `Unknown inference task: ${String(key)}`)
    return task as TaskDefinition<TaskInput<K>, TaskOutput<K>>
}

const NO_PROGRESS: Procedure<unitValue> = () => {}

export namespace Inference {
    export const install = (config: InstallOptions): void => {
        installInferenceConfig({opfs: config.opfs})
        host.match({
            none: () => {},
            some: existing => {existing.shutdown().catch(() => {})}
        })
        host = Option.wrap(new EngineHost({
            workerFactory: config.workerFactory ?? defaultWorkerFactory
        }))
    }

    export const run = <K extends TaskKey>(key: K,
                                           input: TaskInput<K>,
                                           options?: RunOptions): Promise<TaskOutput<K>> => {
        requireInferenceConfig()
        const engineHost = requireHost()
        const task = lookupTask(key)
        const progress = options?.progress ?? NO_PROGRESS
        const signal = isDefined(options?.signal) ? Option.wrap(options.signal) : Option.None
        return engineHost.enqueue(() => runTask<TaskInput<K>, TaskOutput<K>>(engineHost, {
            task,
            input,
            progress,
            signal,
            executionProviders: resolveProviders(task.executionProviders, options?.executionProvider),
            downloadShare: options?.downloadShare
        }))
    }

    /**
     * Whether the model bytes for `key` are already cached in OPFS with a
     * SHA-256 matching the task definition. Useful for deciding whether to
     * show a download dialog before calling `preload` or `run`.
     */
    export const isCached = async <K extends TaskKey>(key: K): Promise<boolean> => {
        requireInferenceConfig()
        const task = lookupTask(key)
        return ModelStore.isCached(task.key, task.model)
    }

    /**
     * The model descriptor (URL, SHA-256, bytes, version) for a task. Useful
     * for formatting download-size messages in confirmation dialogs without
     * duplicating the bytes/version values in the consumer.
     */
    export const modelDescriptor = <K extends TaskKey>(key: K): ModelDescriptor =>
        lookupTask(key).model

    /**
     * Ensure the model is downloaded (cache hit or fresh fetch with progress)
     * AND its session is created in the worker. Resolves once the session is
     * ready to run inference. Subsequent `run` calls are inference-only.
     */
    export const preload = async <K extends TaskKey>(
        key: K,
        options?: PreloadOptions
    ): Promise<void> => {
        requireInferenceConfig()
        const engineHost = requireHost()
        const task = lookupTask(key)
        await engineHost.enqueue(() => engineHost.ensureLoaded(
            task.key, task.model, resolveProviders(task.executionProviders, options?.executionProvider), {
                progress: options?.progress,
                signal: options?.signal
            }))
    }

    /**
     * Release the in-memory session for `key` (if any). The model bytes stay
     * cached in OPFS, so a subsequent `preload` with a different
     * `executionProvider` is the cheap way to switch EPs at runtime.
     */
    export const releaseTask = async <K extends TaskKey>(key: K): Promise<void> => {
        requireInferenceConfig()
        const engineHost = requireHost()
        await engineHost.enqueue(() => engineHost.releaseTask(key as string))
    }

    export const acquire = <K extends TaskKey>(key: K, options?: AcquireOptions): Promise<TaskHandle<K>> => {
        requireInferenceConfig()
        const engineHost = requireHost()
        const task = lookupTask(key)
        const executionProviders = resolveProviders(task.executionProviders, options?.executionProvider)
        return engineHost
            .enqueue(() => engineHost.ensureLoaded(task.key, task.model, executionProviders))
            .then(() => new class implements TaskHandle<K> {
                #released: boolean = false
                run(input: TaskInput<K>, options?: RunOptions): Promise<TaskOutput<K>> {
                    if (this.#released) {
                        return Promise.reject(new InferenceEngineError("TaskHandle has been released"))
                    }
                    const progress = options?.progress ?? NO_PROGRESS
                    const signal = isDefined(options?.signal) ? Option.wrap(options.signal) : Option.None
                    return engineHost.enqueue(() => runTask<TaskInput<K>, TaskOutput<K>>(engineHost, {
                        task,
                        input,
                        progress,
                        signal,
                        executionProviders: resolveProviders(task.executionProviders, options?.executionProvider)
                    }))
                }

                terminate(): void {
                    if (this.#released) {return}
                    this.#released = true
                    engineHost.enqueue(() => engineHost.releaseTask(task.key)).catch(EmptyExec)
                }
            })
    }

    export const shutdown = (): Promise<void> => {
        if (host.isEmpty()) {return Promise.resolve()}
        const engineHost = host.unwrap()
        host = Option.None
        return engineHost.shutdown()
    }
}
