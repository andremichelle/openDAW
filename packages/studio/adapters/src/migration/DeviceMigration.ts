import {BoxGraph} from "@opendaw/lib-box"
import {ArpeggioDeviceBox, BoxIO, BoxVisitor, DelayDeviceBox} from "@opendaw/studio-boxes"
import {migrateDelayDeviceBox} from "./MigrateDelayDeviceBox"
import {migrateArpeggioDeviceBox} from "./MigrateArpeggioDeviceBox"

// Shared by the project migration and the preset decoder, so old presets never enter a project unmigrated.
export namespace DeviceMigration {
    export const visitor = (boxGraph: BoxGraph<BoxIO.TypeMap>): BoxVisitor => ({
        visitDelayDeviceBox: (box: DelayDeviceBox) => migrateDelayDeviceBox(boxGraph, box),
        visitArpeggioDeviceBox: (box: ArpeggioDeviceBox) => migrateArpeggioDeviceBox(boxGraph, box)
    })

    export const migrate = (boxGraph: BoxGraph<BoxIO.TypeMap>): void => {
        const visitor = DeviceMigration.visitor(boxGraph)
        boxGraph.boxes().slice().forEach(box => box.accept<BoxVisitor>(visitor))
    }
}
