import {Editing, Errors, UUID} from "@opendaw/lib-std"
import {RuntimeNotifier} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {NeuralAmpModelBox} from "@opendaw/studio-boxes"
import {BoxGraph} from "@opendaw/lib-box"
import {NeuralAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Workers} from "@opendaw/studio-core"
import {showTone3000Dialog} from "./Tone3000Dialog"

type ToneModel = { id: number, name: string, size: string, model_url: string }
type ToneResponse = { id: number, title: string, updated_at: string, models: ReadonlyArray<ToneModel> }

export type PackMeta = {
    toneId: number
    title: string
    updatedAt: string
    models: ReadonlyArray<{ id: number, name: string, size: string }>
}

const AppId = "openDAW"
const SelectEndpoint = "https://www.tone3000.com/api/v1/select"
const StorageKey = "tone3000_tone_url"
const StorageDoneKey = "tone3000_done"

const packPath = (toneId: number): string => `tone3000/${toneId}`
const packMetaPath = (toneId: number): string => `${packPath(toneId)}/pack.json`
const modelPath = (toneId: number, modelId: number): string => `${packPath(toneId)}/models/${modelId}.nam`

const waitForToneUrl = (): Promise<string> => {
    return new Promise<string>((resolve) => {
        localStorage.removeItem(StorageKey)
        localStorage.removeItem(StorageDoneKey)
        const onStorage = (event: StorageEvent) => {
            if (event.key === StorageKey && event.newValue !== null) {
                window.removeEventListener("storage", onStorage)
                resolve(event.newValue)
            }
        }
        window.addEventListener("storage", onStorage)
    })
}

const fetchTone = async (toneUrl: string): Promise<ToneResponse> => {
    const response = await fetch(toneUrl)
    if (!response.ok) {throw new Error(`Failed to fetch tone: ${response.status}`)}
    return response.json()
}

const downloadModel = async (modelUrl: string): Promise<string> => {
    const response = await fetch(modelUrl)
    if (!response.ok) {throw new Error(`Failed to download model: ${response.status}`)}
    return response.text()
}

const readPackMeta = async (toneId: number): Promise<PackMeta | null> => {
    const path = packMetaPath(toneId)
    if (!await Workers.Opfs.exists(path)) {return null}
    const bytes = await Workers.Opfs.read(path)
    return JSON.parse(new TextDecoder().decode(bytes))
}

export const readPackMetaFromId = async (packId: string): Promise<PackMeta | null> => {
    const toneId = parseInt(packId, 10)
    if (isNaN(toneId)) {return null}
    return readPackMeta(toneId)
}

export const readModelFromPack = async (packId: string, modelId: number): Promise<string> => {
    const toneId = parseInt(packId, 10)
    const bytes = await Workers.Opfs.read(modelPath(toneId, modelId))
    return new TextDecoder().decode(bytes)
}

const storePackToOpfs = async (tone: ToneResponse): Promise<PackMeta> => {
    const toneId = tone.id
    const existingMeta = await readPackMeta(toneId)
    if (existingMeta !== null && existingMeta.updatedAt === tone.updated_at) {
        return existingMeta
    }
    const dialog = RuntimeNotifier.progress({headline: `Downloading ${tone.title}...`})
    try {
        const concurrency = 4
        const models = tone.models
        let completed = 0
        const downloadAndStore = async (model: ToneModel): Promise<void> => {
            const text = await downloadModel(model.model_url)
            await Workers.Opfs.write(modelPath(toneId, model.id), new TextEncoder().encode(text))
            completed++
            dialog.message = `${completed} / ${models.length} models`
        }
        for (let i = 0; i < models.length; i += concurrency) {
            const batch = models.slice(i, i + concurrency)
            await Promise.all(batch.map(downloadAndStore))
        }
        const meta: PackMeta = {
            toneId,
            title: tone.title,
            updatedAt: tone.updated_at,
            models: tone.models.map(model => ({id: model.id, name: model.name, size: model.size}))
        }
        await Workers.Opfs.write(packMetaPath(toneId), new TextEncoder().encode(JSON.stringify(meta)))
        return meta
    } finally {
        dialog.terminate()
    }
}

const pickDefaultModel = (meta: PackMeta): PackMeta["models"][number] => {
    const standard = meta.models.find(model => model.size === "standard")
    return standard ?? meta.models[0]
}

export namespace NamTone3000 {
    export const browse = (boxGraph: BoxGraph, editing: Editing, adapter: NeuralAmpDeviceBoxAdapter) => async () => {
        const {status} = await Promises.tryCatch(showTone3000Dialog())
        if (status === "rejected") {return}
        try {
            const redirectUrl = `${window.location.origin}/tone3000-callback.html`
            const url = `${SelectEndpoint}?app_id=${AppId}&redirect_url=${encodeURIComponent(redirectUrl)}&platform=nam`
            const toneUrlPromise = waitForToneUrl()
            window.open(url, "tone3000")
            const toneUrl = await toneUrlPromise
            localStorage.setItem(StorageDoneKey, "true")
            const tone = await fetchTone(toneUrl)
            if (tone.models.length === 0) {return}
            const meta = await storePackToOpfs(tone)
            const defaultModel = pickDefaultModel(meta)
            const text = await readModelFromPack(meta.toneId.toString(), defaultModel.id)
            const jsonBuffer = new TextEncoder().encode(text)
            const uuid = await UUID.sha256(jsonBuffer.buffer as ArrayBuffer)
            editing.modify(() => {
                const oldTarget = adapter.box.model.targetVertex
                const modelBox = boxGraph.findBox<NeuralAmpModelBox>(uuid).unwrapOrElse(() =>
                    NeuralAmpModelBox.create(boxGraph, uuid, box => {
                        box.label.setValue(`${meta.title} — ${defaultModel.name}`)
                        box.model.setValue(text)
                        box.packId.setValue(meta.toneId.toString())
                    }))
                adapter.box.model.refer(modelBox)
                if (oldTarget.nonEmpty()) {
                    const oldVertex = oldTarget.unwrap()
                    if (oldVertex !== modelBox && oldVertex.pointerHub.isEmpty()) {
                        oldVertex.box.unstage()
                    }
                }
            })
        } catch (error) {
            if (Errors.isAbort(error)) {return}
            console.error("Failed to load NAM model from Tone 3000:", error)
        }
    }

    export const loadModelFromPack = async (
        packId: string, modelId: number, modelName: string,
        boxGraph: BoxGraph, editing: Editing, adapter: NeuralAmpDeviceBoxAdapter,
        packTitle: string
    ): Promise<void> => {
        const text = await readModelFromPack(packId, modelId)
        const jsonBuffer = new TextEncoder().encode(text)
        const uuid = await UUID.sha256(jsonBuffer.buffer as ArrayBuffer)
        editing.modify(() => {
            const oldTarget = adapter.box.model.targetVertex
            const modelBox = boxGraph.findBox<NeuralAmpModelBox>(uuid).unwrapOrElse(() =>
                NeuralAmpModelBox.create(boxGraph, uuid, box => {
                    box.label.setValue(`${packTitle} — ${modelName}`)
                    box.model.setValue(text)
                    box.packId.setValue(packId)
                }))
            adapter.box.model.refer(modelBox)
            if (oldTarget.nonEmpty()) {
                const oldVertex = oldTarget.unwrap()
                if (oldVertex !== modelBox && oldVertex.pointerHub.isEmpty()) {
                    oldVertex.box.unstage()
                }
            }
        })
    }
}
