import {BoxGraph} from "@opendaw/lib-box"
import {UUID} from "@opendaw/lib-std"
import {BoxIO, NeuralAmpDeviceBox, NeuralAmpModelBox} from "@opendaw/studio-boxes"

export const migrateNeuralAmpDeviceBox = async (boxGraph: BoxGraph<BoxIO.TypeMap>, box: NeuralAmpDeviceBox): Promise<void> => {
    const oldJson = box.modelJson.getValue()
    if (oldJson.length === 0) {return}
    if (box.model.targetVertex.nonEmpty()) {return}
    const jsonBuffer = new TextEncoder().encode(oldJson)
    const uuid = await UUID.sha256(jsonBuffer.buffer as ArrayBuffer)
    let modelBox: NeuralAmpModelBox | null = null
    for (const existing of boxGraph.boxes()) {
        if (existing instanceof NeuralAmpModelBox && UUID.equals(existing.address.uuid, uuid)) {
            modelBox = existing
            break
        }
    }
    boxGraph.beginTransaction()
    if (modelBox === null) {
        modelBox = NeuralAmpModelBox.create(boxGraph, uuid)
        modelBox.label.setValue("Imported Model")
        modelBox.model.setValue(oldJson)
    }
    box.model.refer(modelBox)
    boxGraph.endTransaction()
    console.debug(`Migrated NeuralAmpDeviceBox to use NeuralAmpModelBox (${UUID.toString(uuid).slice(0, 8)})`)
}
