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
        objectA: int
        dampingA: number
        tuneA: int
        widthA: number
        objectB: int
        dampingB: number
        tuneB: int
        detuneB: number
        widthB: number
        levelB: number
        routing: int
        couple: number
        volume: number
    }
    export const Factory: ReadonlyArray<Preset> = [
        {
            name: "Velvet Gamelan", exciter: 0, intensity: 0.45, position: 0.42, vibrato: 0.0,
            objectA: 0, dampingA: 0.55, tuneA: 0, widthA: 0.35,
            objectB: 1, dampingB: 0.75, tuneB: 0, detuneB: 7.0, widthB: 0.8, levelB: 0.7,
            routing: 0, couple: 0.22, volume: -9.0
        },
        {
            name: "Log & Skin", exciter: 0, intensity: 0.5, position: 0.5, vibrato: 0.0,
            objectA: 0, dampingA: 0.3, tuneA: 0, widthA: 0.4,
            objectB: 3, dampingB: 0.45, tuneB: -12, detuneB: 0.0, widthB: 0.8, levelB: 0.6,
            routing: 1, couple: 0.0, volume: -9.0
        },
        {
            name: "Foundry Kit", exciter: 0, intensity: 0.9, position: 0.5, vibrato: 0.0,
            objectA: 4, dampingA: 0.25, tuneA: 0, widthA: 0.7,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.0
        },
        {
            name: "Twin Nylon", exciter: 3, intensity: 0.68, position: 0.18, vibrato: 0.0,
            objectA: 0, dampingA: 0.6, tuneA: 0, widthA: 0.6,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.0
        },
        {
            name: "Rosin & Ivory", exciter: 2, intensity: 0.55, position: 0.12, vibrato: 0.25,
            objectA: 5, dampingA: 0.7, tuneA: 0, widthA: 0.5,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.0
        },
        {
            name: "Glass Chapel", exciter: 2, intensity: 0.3, position: 0.25, vibrato: 0.15,
            objectA: 1, dampingA: 0.85, tuneA: 0, widthA: 0.7,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.0
        },
        {
            name: "Ocarina Moon", exciter: 1, intensity: 0.45, position: 0.3, vibrato: 0.0,
            objectA: 0, dampingA: 0.5, tuneA: 0, widthA: 0.3,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.0
        },
        {
            name: "Cathedral of Wires", exciter: 0, intensity: 0.85, position: 0.2, vibrato: 0.0,
            objectA: 2, dampingA: 0.8, tuneA: 0, widthA: 0.5,
            objectB: 5, dampingB: 0.9, tuneB: 12, detuneB: 4.0, widthB: 1.0, levelB: 0.75,
            routing: 1, couple: 0.0, volume: -9.0
        },
        {
            name: "Seance Drum", exciter: 2, intensity: 0.45, position: 0.6, vibrato: 0.2,
            objectA: 3, dampingA: 0.6, tuneA: 0, widthA: 0.85,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.0
        },
        {
            name: "Vesper Choir", exciter: 1, intensity: 0.6, position: 0.3, vibrato: 0.0,
            objectA: 1, dampingA: 0.8, tuneA: 0, widthA: 0.6,
            objectB: 1, dampingB: 0.68, tuneB: 0, detuneB: 5.0, widthB: 1.0, levelB: 0.4,
            routing: 0, couple: 0.12, volume: -9.0
        },
        {
            name: "Pan Flute", exciter: 4, intensity: 0.55, position: 0.3, vibrato: 0.12,
            objectA: 0, dampingA: 0.45, tuneA: 0, widthA: 0.25,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -8.5
        },
        {
            name: "Shakuhachi", exciter: 4, intensity: 0.8, position: 0.6, vibrato: 0.35,
            objectA: 3, dampingA: 0.6, tuneA: 0, widthA: 0.3,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.5
        },
        {
            name: "Silver Flute", exciter: 4, intensity: 0.6, position: 0.35, vibrato: 0.25,
            objectA: 1, dampingA: 0.65, tuneA: 0, widthA: 0.35,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.0
        },
        {
            name: "Whistle Wind", exciter: 1, intensity: 0.9, position: 0.5, vibrato: 0.0,
            objectA: 4, dampingA: 0.3, tuneA: 0, widthA: 0.9,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -14.5
        },
        {
            name: "Koto Steps", exciter: 3, intensity: 0.8, position: 0.35, vibrato: 0.0,
            objectA: 5, dampingA: 0.55, tuneA: 0, widthA: 0.5,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.5
        },
        {
            name: "Moon Bow", exciter: 2, intensity: 0.25, position: 0.35, vibrato: 0.3,
            objectA: 2, dampingA: 0.8, tuneA: 0, widthA: 0.8,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -9.0
        },
        {
            name: "Tank Drum", exciter: 0, intensity: 0.3, position: 0.3, vibrato: 0.0,
            objectA: 2, dampingA: 0.55, tuneA: 0, widthA: 0.6,
            objectB: 6, dampingB: 0.5, tuneB: 0, detuneB: 0.0, widthB: 0.8, levelB: 0.5,
            routing: 0, couple: 0.0, volume: -13.0
        },
        {
            name: "First Frost", exciter: 0, intensity: 0.2, position: 0.35, vibrato: 0.0,
            objectA: 1, dampingA: 0.9, tuneA: 0, widthA: 0.5,
            objectB: 1, dampingB: 0.85, tuneB: 12, detuneB: 2.0, widthB: 1.0, levelB: 0.5,
            routing: 0, couple: 0.08, volume: -8.0
        }
    ]
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1.0e-3
    export const matches = (box: KorpusDeviceBox, preset: Preset): boolean =>
        box.exciter.getValue() === preset.exciter
        && near(box.intensity.getValue(), preset.intensity)
        && near(box.position.getValue(), preset.position)
        && near(box.vibrato.getValue(), preset.vibrato)
        && box.objectA.getValue() === preset.objectA
        && near(box.dampingA.getValue(), preset.dampingA)
        && box.tuneA.getValue() === preset.tuneA
        && near(box.widthA.getValue(), preset.widthA)
        && box.objectB.getValue() === preset.objectB
        && near(box.dampingB.getValue(), preset.dampingB)
        && box.tuneB.getValue() === preset.tuneB
        && near(box.detuneB.getValue(), preset.detuneB)
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
        box.objectA.setValue(preset.objectA)
        box.dampingA.setValue(preset.dampingA)
        box.tuneA.setValue(preset.tuneA)
        box.widthA.setValue(preset.widthA)
        box.objectB.setValue(preset.objectB)
        box.dampingB.setValue(preset.dampingB)
        box.tuneB.setValue(preset.tuneB)
        box.detuneB.setValue(preset.detuneB)
        box.widthB.setValue(preset.widthB)
        box.levelB.setValue(preset.levelB)
        box.routing.setValue(preset.routing)
        box.couple.setValue(preset.couple)
        box.volume.setValue(preset.volume)
    }
}
