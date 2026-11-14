import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, bipolar, choice} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate

export const OpenDrumPercDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumPercDeviceBox", "notes", {
        10: range("tune", 120, 20, 8000, "exponential", "Hz"),
        11: range("ratio", 1, 0.25, 16, "exponential", ""),
        12: unipolar("index", 0.2),
        13: range("bite", 0.03, 0.001, 2, "exponential", "s"),
        14: range("pitch", 48, -48, 48, "linear", "st"),
        15: range("sweep", 0.02, 0.0005, 2, "exponential", "s"),
        16: range("decay", 0.2, 0.005, 4, "exponential", "s"),
        17: bipolar("curve", 0),
        18: unipolar("noise", 0),
        19: range("drive", 0, 0, 36, "linear", "dB"),
        20: range("volume", 0, -36, 6, "linear", "dB"),
        21: unipolar("velocity", 1),
        22: choice("play", 0, PlayModes)
    })
