import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, choice} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate

export const OpenDrumBellDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumBellDeviceBox", "notes", {
        10: range("tune", 558, 50, 4000, "exponential", "Hz"),
        11: range("ratio", 1.477, 1, 4, "linear", ""),
        12: unipolar("balance", 0.7),
        13: range("color", 1050, 100, 16000, "exponential", "Hz"),
        14: unipolar("strike", 0.8),
        15: range("decay", 0.7, 0.01, 4, "exponential", "s"),
        16: range("volume", 0, -36, 6, "linear", "dB"),
        17: unipolar("velocity", 1),
        18: choice("play", 0, PlayModes)
    })
