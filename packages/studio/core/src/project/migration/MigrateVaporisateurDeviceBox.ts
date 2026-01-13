import {BoxGraph, Field} from "@moises-ai/lib-box"
import {BoxIO, VaporisateurDeviceBox} from "@moises-ai/studio-boxes"

export const migrateVaporisateurDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: VaporisateurDeviceBox): void => {
    if (box.version.getValue() === 0) {
        console.debug("Migrate 'VaporisateurDeviceBox to zero db")
        boxGraph.beginTransaction()
        box.volume.setValue(box.volume.getValue() - 15.0)
        box.version.setValue(1)
        boxGraph.endTransaction()
    }
    if (box.version.getValue() === 1) {
        console.debug("Migrate 'VaporisateurDeviceBox to extended osc")
        boxGraph.beginTransaction()
        const [oscA, oscB] = box.oscillators.fields()
        const movePointers = (oldTarget: Field, newTarget: Field) => {
            oldTarget.pointerHub.incoming().forEach((pointer) => pointer.refer(newTarget))
        }
        movePointers(box.waveform, oscA.waveform)
        movePointers(box.octave, oscA.octave)
        movePointers(box.tune, oscA.tune)
        movePointers(box.volume, oscA.volume)
        oscA.waveform.setValue(box.waveform.getValue())
        oscA.octave.setValue(box.octave.getValue())
        oscA.tune.setValue(box.tune.getValue())
        oscA.volume.setValue(box.volume.getValue())
        oscB.volume.setValue(Number.NEGATIVE_INFINITY)
        box.version.setValue(2)
        boxGraph.endTransaction()
    }
}
