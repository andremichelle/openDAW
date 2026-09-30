import {KorpusDeviceBox} from "@opendaw/studio-boxes"
import {int} from "@opendaw/lib-std"

// Call `apply` inside `editing.modify` so a preset load is one undoable transaction.
export namespace KorpusPresets {
    export type Preset = {
        name: string
        exciter: int
        intensity: number
        position: number
        vibrato: number
        air: number
        stroke: number
        objectA: int
        dampingA: number
        tuneA: int
        widthA: number
        levelA: number
        objectB: int
        dampingB: number
        tuneB: number
        widthB: number
        levelB: number
        routing: int
        couple: number
        volume: number
    }
    export const Factory: ReadonlyArray<Preset> = []
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1.0e-3
    export const matches = (box: KorpusDeviceBox, preset: Preset): boolean =>
        box.exciter.getValue() === preset.exciter
        && near(box.intensity.getValue(), preset.intensity)
        && near(box.position.getValue(), preset.position)
        && near(box.vibrato.getValue(), preset.vibrato)
        && near(box.air.getValue(), preset.air)
        && near(box.stroke.getValue(), preset.stroke)
        && box.objectA.getValue() === preset.objectA
        && near(box.dampingA.getValue(), preset.dampingA)
        && box.tuneA.getValue() === preset.tuneA
        && near(box.widthA.getValue(), preset.widthA)
        && near(box.levelA.getValue(), preset.levelA)
        && box.objectB.getValue() === preset.objectB
        && near(box.dampingB.getValue(), preset.dampingB)
        && near(box.tuneB.getValue(), preset.tuneB)
        && near(box.widthB.getValue(), preset.widthB)
        && near(box.levelB.getValue(), preset.levelB)
        && box.routing.getValue() === preset.routing
        && near(box.couple.getValue(), preset.couple)
        && near(box.volume.getValue(), preset.volume)
    export const apply = (box: KorpusDeviceBox, preset: Preset): void => {
        box.presetEpoch.setValue(box.presetEpoch.getValue() + 1)
        box.exciter.setValue(preset.exciter)
        box.intensity.setValue(preset.intensity)
        box.position.setValue(preset.position)
        box.vibrato.setValue(preset.vibrato)
        box.air.setValue(preset.air)
        box.stroke.setValue(preset.stroke)
        box.objectA.setValue(preset.objectA)
        box.dampingA.setValue(preset.dampingA)
        box.tuneA.setValue(preset.tuneA)
        box.widthA.setValue(preset.widthA)
        box.levelA.setValue(preset.levelA)
        box.objectB.setValue(preset.objectB)
        box.dampingB.setValue(preset.dampingB)
        box.tuneB.setValue(preset.tuneB)
        box.widthB.setValue(preset.widthB)
        box.levelB.setValue(preset.levelB)
        box.routing.setValue(preset.routing)
        box.couple.setValue(preset.couple)
        box.volume.setValue(preset.volume)
    }
}
