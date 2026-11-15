import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, choice, bipolar} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate

export const OpenDrumCymbalDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumCymbalDeviceBox", "notes", {
        10: range("tune", 1, 0.25, 4, "exponential", ""),
        11: unipolar("tone", 0),
        12: range("attack", 0, 0, 2, "linear", "s"),
        13: range("decay", 0.75, 0.05, 8, "exponential", "s"),
        14: range("volume", 0, -36, 6, "linear", "dB"),
        15: unipolar("velocity", 1),
        16: choice("play", 0, PlayModes),
        17: bipolar("panning", 0.0)
    })
