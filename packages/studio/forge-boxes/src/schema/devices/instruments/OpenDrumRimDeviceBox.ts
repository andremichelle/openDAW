import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, bipolar, choice} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate
const OffOn = 2 // Off, On

export const OpenDrumRimDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumRimDeviceBox", "notes", {
        10: range("tune", 476, 100, 4000, "exponential", "Hz"),
        11: range("ratio", 3.6, 1, 5, "linear", ""),
        12: unipolar("balance", 1),
        13: unipolar("high", 0),
        14: range("high-ratio", 6.3, 1, 12, "linear", ""),
        15: range("ring", 0.17, 0.005, 1, "exponential", "s"),
        16: range("ring-high", 0.035, 0.005, 1, "exponential", "s"),
        17: range("decay", 0.012, 0.002, 0.5, "exponential", "s"),
        18: bipolar("punch", 0.7),
        19: range("drive", 12, 0, 36, "linear", "dB"),
        20: unipolar("hard", 0),
        21: unipolar("click", 0.05),
        22: range("swell", 3, 0, 8, "linear", ""),
        23: range("cut", 300, 20, 4000, "exponential", "Hz"),
        24: choice("restart", 1, OffOn),
        25: range("volume", -3, -36, 6, "linear", "dB"),
        26: unipolar("velocity", 1),
        27: choice("play", 0, PlayModes),
        28: bipolar("panning", 0.0)
    })
