import {asDefined, isDefined, Option, panic, Procedure, tryCatch, unitValue} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {OpfsProtocol} from "@opendaw/lib-fusion"
import {ModelDescriptor} from "./Task"
import {requireInferenceConfig} from "./InferenceConfig"

export interface FetchOptions {
    readonly progress?: Procedure<unitValue>
    readonly signal?: AbortSignal
    /** False permits cache reads only, including if a previously probed cache entry disappears. */
    readonly allowDownload?: boolean
}

interface ModelMeta {
    readonly sha256: string
    readonly bytes: number
    readonly version: string
    readonly downloadedAt: number
}

const ROOT = "inference/models"
const MODEL_FILE = "model.onnx"
const META_FILE = "meta.json"

const modelPath = (taskKey: string, version: string) => `${ROOT}/${taskKey}/${version}/${MODEL_FILE}`
const metaPath = (taskKey: string, version: string) => `${ROOT}/${taskKey}/${version}/${META_FILE}`
const taskPath = (taskKey: string) => `${ROOT}/${taskKey}`
const versionPath = (taskKey: string, version: string) => `${ROOT}/${taskKey}/${version}`

export namespace ModelStore {
    export const ensure = async (taskKey: string,
                                 model: ModelDescriptor,
                                 options?: FetchOptions): Promise<Uint8Array> => {
        const {opfs} = requireInferenceConfig()
        const cached = await readCached(opfs, taskKey, model)
        if (cached.nonEmpty()) {
            options?.progress?.(1.0)
            return cached.unwrap()
        }
        if (options?.allowDownload === false) {throw new Error("Model download requires confirmation. Please try again.")}
        const bytes = await download(model, options)
        const digest = await sha256Hex(bytes)
        if (digest !== model.sha256) {
            return panic(`Model SHA-256 mismatch for ${taskKey}: expected ${model.sha256}, got ${digest}`)
        }
        await opfs.write(modelPath(taskKey, model.version), bytes)
        const meta: ModelMeta = {
            sha256: model.sha256,
            bytes: bytes.byteLength,
            version: model.version,
            downloadedAt: Date.now()
        }
        await opfs.write(metaPath(taskKey, model.version), new TextEncoder().encode(JSON.stringify(meta)))
        return bytes
    }

    export const evict = async (taskKey: string, version?: string): Promise<void> => {
        const {opfs} = requireInferenceConfig()
        const path = isDefined(version) ? versionPath(taskKey, version) : taskPath(taskKey)
        await Promises.tryCatch(opfs.delete(path))
    }

    export const isCached = async (taskKey: string, model: ModelDescriptor): Promise<boolean> => {
        const {opfs} = requireInferenceConfig()
        const meta = await readMeta(opfs, taskKey, model.version)
        if (meta.isEmpty() || meta.unwrap().sha256 !== model.sha256) {return false}
        // Trust meta.json's recorded sha; avoid reading 300+ MB just to probe.
        return opfs.exists(modelPath(taskKey, model.version))
    }

    const readCached = async (opfs: OpfsProtocol,
                              taskKey: string,
                              model: ModelDescriptor): Promise<Option<Uint8Array>> => {
        const meta = await readMeta(opfs, taskKey, model.version)
        if (meta.isEmpty() || meta.unwrap().sha256 !== model.sha256) {return Option.None}
        const result = await Promises.tryCatch(opfs.read(modelPath(taskKey, model.version)))
        return result.status === "resolved" ? Option.wrap(result.value) : Option.None
    }

    const readMeta = async (opfs: OpfsProtocol,
                            taskKey: string,
                            version: string): Promise<Option<ModelMeta>> => {
        const result = await Promises.tryCatch(opfs.read(metaPath(taskKey, version)))
        if (result.status === "rejected") {return Option.None}
        const {status, value} = tryCatch(() =>
            JSON.parse(new TextDecoder().decode(result.value)) as ModelMeta)
        return status === "success" ? Option.wrap(value) : Option.None
    }

    const download = async (model: ModelDescriptor, options?: FetchOptions): Promise<Uint8Array> => {
        // Cross-origin fetches under COOP+COEP need explicit cors/no-credentials
        // mode so the response is treated as a permitted resource.
        const response = await fetch(model.url, {
            signal: options?.signal,
            mode: "cors",
            credentials: "omit"
        })
        if (!response.ok) {
            return panic(`Model fetch failed: ${response.status} ${response.statusText} (${model.url})`)
        }
        const total = parseInt(response.headers.get("Content-Length") ?? `${model.bytes}`)
        const reader = asDefined(response.body, "Empty response body").getReader()
        const chunks: Array<Uint8Array> = []
        let loaded = 0
        while (true) {
            const {done, value} = await reader.read()
            if (done) {break}
            chunks.push(value)
            loaded += value.length
            options?.progress?.(total > 0 ? Math.min(loaded / total, 1.0) : 0.5)
        }
        const result = new Uint8Array(loaded)
        let offset = 0
        for (const chunk of chunks) {
            result.set(chunk, offset)
            offset += chunk.length
        }
        return result
    }

    const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
        const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
        return Array.from(new Uint8Array(digest))
            .map(byte => byte.toString(16).padStart(2, "0"))
            .join("")
    }
}
