import {Editing, Errors, UUID} from "@moises-ai/lib-std"
import {Promises} from "@moises-ai/lib-runtime"
import {NeuralAmpModelBox} from "@moises-ai/studio-boxes"
import {BoxGraph} from "@moises-ai/lib-box"
import {NeuralAmpDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {showTone3000Dialog} from "./Tone3000Dialog"

type ToneModel = { name: string, size: string, model_url: string }
type ToneResponse = { title: string, models: ReadonlyArray<ToneModel> }

const AppId = "openDAW"
const SelectEndpoint = "https://www.tone3000.com/api/v1/select"
const StorageKey = "tone3000_tone_url"
const StorageDoneKey = "tone3000_done"

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

const pickModel = (tone: ToneResponse): ToneModel => {
    const standard = tone.models.find(model => model.size === "standard")
    return standard ?? tone.models[0]
}

const downloadModel = async (modelUrl: string): Promise<string> => {
    const response = await fetch(modelUrl)
    if (!response.ok) {throw new Error(`Failed to download model: ${response.status}`)}
    return response.text()
}

export namespace NamTone3000 {
    export const browse = (boxGraph: BoxGraph, editing: Editing, adapter: NeuralAmpDeviceBoxAdapter) => async () => {
        const {status} = await Promises.tryCatch(showTone3000Dialog())
        if (status === "rejected") {return}
        try {
            const redirectUrl = `${window.location.origin}/tone3000-callback.html`
            const url = `${SelectEndpoint}?app_id=${AppId}&redirect_url=${encodeURIComponent(redirectUrl)}`
            const toneUrlPromise = waitForToneUrl()
            window.open(url, "tone3000")
            const toneUrl = await toneUrlPromise
            const tone = await fetchTone(toneUrl)
            if (tone.models.length === 0) {return}
            const model = pickModel(tone)
            const text = await downloadModel(model.model_url)
            const jsonBuffer = new TextEncoder().encode(text)
            const uuid = await UUID.sha256(jsonBuffer.buffer as ArrayBuffer)
            editing.modify(() => {
                const oldTarget = adapter.box.model.targetVertex
                const modelBox = boxGraph.findBox<NeuralAmpModelBox>(uuid).unwrapOrElse(() =>
                    NeuralAmpModelBox.create(boxGraph, uuid, box => {
                        box.label.setValue(`${tone.title} — ${model.name}`)
                        box.model.setValue(text)
                    }))
                adapter.box.model.refer(modelBox)
                if (oldTarget.nonEmpty()) {
                    const oldVertex = oldTarget.unwrap()
                    if (oldVertex !== modelBox && oldVertex.pointerHub.isEmpty()) {
                        oldVertex.box.unstage()
                    }
                }
            })
            localStorage.setItem(StorageDoneKey, "true")
        } catch (error) {
            if (Errors.isAbort(error)) {return}
            console.error("Failed to load NAM model from Tone 3000:", error)
        }
    }
}
