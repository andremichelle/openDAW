import {Files} from "@moises-ai/lib-dom"
import {Editing, UUID} from "@moises-ai/lib-std"
import {NeuralAmpModelBox} from "@moises-ai/studio-boxes"
import {BoxGraph} from "@moises-ai/lib-box"
import {NeuralAmpDeviceBoxAdapter} from "@moises-ai/studio-adapters"

export namespace NamLocal {
    export const browse = (boxGraph: BoxGraph, editing: Editing, adapter: NeuralAmpDeviceBoxAdapter) => async () => {
        try {
            const files = await Files.open({
                types: [{description: "NAM Model", accept: {"application/json": [".nam"]}}],
                multiple: false
            })
            if (files.length > 0) {
                const file = files[0]
                const text = await file.text()
                const jsonBuffer = new TextEncoder().encode(text)
                const uuid = await UUID.sha256(jsonBuffer.buffer as ArrayBuffer)
                editing.modify(() => {
                    const oldTarget = adapter.box.model.targetVertex
                    const modelBox = boxGraph.findBox<NeuralAmpModelBox>(uuid).unwrapOrElse(() =>
                        NeuralAmpModelBox.create(boxGraph, uuid, box => {
                            box.label.setValue(file.name.replace(/\.nam$/i, ""))
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
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {return}
            console.error("Failed to load NAM model:", error)
        }
    }
}