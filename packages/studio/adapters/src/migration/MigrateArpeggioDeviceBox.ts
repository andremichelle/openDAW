import {Box, BoxGraph} from "@opendaw/lib-box"
import {clamp, isDefined, Maybe} from "@opendaw/lib-std"
import {ArpeggioDeviceBox, BoxIO, BoxVisitor, ModulationBox} from "@opendaw/studio-boxes"
import {migrateAutomation} from "./MigrateAutomation"

// Version 0 had 3 modes (Up, Down, UpDown), version 1 has 18 with those three kept at indices 0, 1, 2.
const OldModeMax = 2
const NewModeMax = 17

const asModulation = (box: Box): Maybe<ModulationBox> =>
    box.accept<BoxVisitor<ModulationBox>>({visitModulationBox: modulation => modulation})

export const migrateArpeggioModeUnit = (unit: number): number =>
    Math.round(clamp(unit, 0.0, 1.0) * OldModeMax) / NewModeMax

export const migrateArpeggioModeDepth = (depth: number): number => depth * OldModeMax / NewModeMax

export const migrateArpeggioDeviceBox = (boxGraph: BoxGraph<BoxIO.TypeMap>, box: ArpeggioDeviceBox): void => {
    if (box.version.getValue() !== 0) {return}
    console.debug("Migrate 'ArpeggioDeviceBox' mode automation and modulation to 18 modes")
    boxGraph.beginTransaction()
    migrateAutomation(boxGraph, box.modeIndex, migrateArpeggioModeUnit)
    box.modeIndex.pointerHub.incoming().map(pointer => asModulation(pointer.box)).filter(isDefined).forEach(modulation => {
        modulation.depth.setValue(migrateArpeggioModeDepth(modulation.depth.getValue()))
        migrateAutomation(boxGraph, modulation.depth, unit => (migrateArpeggioModeDepth(unit * 2.0 - 1.0) + 1.0) / 2.0)
    })
    box.version.setValue(1)
    boxGraph.endTransaction()
}
