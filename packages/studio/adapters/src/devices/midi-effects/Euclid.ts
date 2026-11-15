import {asInstanceOf, int, UUID} from "@opendaw/lib-std"
import {BoxGraph, Float32Field, IndexedBox, Int32Field} from "@opendaw/lib-box"
import {EuclidDeviceBox, EuclidLaneBox} from "@opendaw/studio-boxes"

/** What the Euclid editor, the scripts and the engine share. */
export namespace Euclid {
    export const Patterns = 8
    export const Off = -1
    export const MaxLanes = 127
    export const MaxSteps = 32
    export const MinRepeats = 2
    export const MaxRepeats = 8
    export const MaxLength = 128
    // WASM CONTRACT: the broadcast of the active and the waiting pattern (device-euclid STATE)
    export const StateKey = 0xFFF
    export const NoPattern = -2
    /** The note values of a lane's rate: 1/4, 1/8, 1/16, 1/32, each straight, triplet, dotted. */
    export const Values: ReadonlyArray<string> = ["1/4", "1/8", "1/16", "1/32"]
        .flatMap(name => [name, `${name}T`, `${name}.`])
    export const ValueQuarters: ReadonlyArray<number> = [1, 0.5, 0.25, 0.125]
        .flatMap(quarters => [quarters, quarters * 2.0 / 3.0, quarters * 1.5])
    export const GlobalRates: ReadonlyArray<string> = ["÷4", "÷2", "×1", "×2", "×4"]
    export const GlobalFactors: ReadonlyArray<number> = [0.25, 0.5, 1, 2, 4]
    export const Gates: ReadonlyArray<string> = ["Step", "Next hit"]

    /** The fields of a lane's rhythm in one pattern. */
    export type Rhythm = {
        readonly steps: Int32Field, readonly pulses: Int32Field, readonly rotate: Int32Field, readonly rate: Int32Field
        readonly accents: Int32Field, readonly accentRotate: Int32Field
        readonly bursts: Int32Field, readonly burstRotate: Int32Field, readonly repeats: Int32Field, readonly fade: Float32Field
    }

    // keys 10 + pattern * 10 + entry, in the order of EuclidLaneBox
    export const rhythmOf = (lane: EuclidLaneBox, pattern: int): Rhythm => {
        const record = lane.record()
        const int = (entry: int): Int32Field => asInstanceOf(record[String(10 + pattern * 10 + entry)], Int32Field)
        return {
            steps: int(0), pulses: int(1), rotate: int(2), rate: int(3), accents: int(4), accentRotate: int(5),
            bursts: int(6), burstRotate: int(7), repeats: int(8),
            fade: asInstanceOf(record[String(10 + pattern * 10 + 9)], Float32Field)
        }
    }

    export const lanesOf = (device: EuclidDeviceBox): ReadonlyArray<EuclidLaneBox> =>
        IndexedBox.collectIndexedBoxes(device.lanes, EuclidLaneBox)

    export const createLane = (boxGraph: BoxGraph, device: EuclidDeviceBox, note: int): EuclidLaneBox =>
        EuclidLaneBox.create(boxGraph, UUID.generate(), box => {
            box.device.refer(device.lanes)
            box.index.setValue(lanesOf(device).length)
            box.note.setValue(note)
        })

    /** Moves a lane to `to` in the list and renumbers every lane densely. */
    export const moveLane = (device: EuclidDeviceBox, from: int, to: int): void => {
        const lanes = [...lanesOf(device)]
        const [moved] = lanes.splice(from, 1)
        lanes.splice(to, 0, moved)
        lanes.forEach((lane, index) => lane.index.setValue(index))
    }

    export const removeLane = (device: EuclidDeviceBox, lane: EuclidLaneBox): void => {
        IndexedBox.removeOrder(device.lanes, lane.index.getValue())
        lane.delete()
    }
}
