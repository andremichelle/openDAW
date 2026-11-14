import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, bipolar, choice} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate

export const OpenDrumTomDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumTomDeviceBox", "notes", {
        10: range("tune", 88, 40, 800, "exponential", "Hz"),
        11: range("pitch", 0.4, 0, 24, "linear", "st"),
        12: range("sweep", 0.05, 0.001, 0.2, "exponential", "s"),
        13: range("drift", 0, 0, 12, "linear", "st"),
        14: range("decay", 0.62, 0.02, 3, "exponential", "s"),
        15: bipolar("punch", 0),
        16: unipolar("shape", 0),
        17: unipolar("sub", 0),
        18: range("ratio", 0.67, 0.5, 1, "linear", ""),
        19: unipolar("top", 0),
        20: range("length", 0.2, 0.02, 1, "exponential", "s"),
        21: range("drive", 0, 0, 36, "linear", "dB"),
        22: range("noise", -34, -48, 0, "linear", "dB"),
        23: range("noise-decay", 0.7, 0.02, 3, "exponential", "s"),
        24: unipolar("color", 0),
        25: unipolar("air", 0),
        26: range("volume", 0, -36, 6, "linear", "dB"),
        27: unipolar("velocity", 1),
        28: choice("play", 0, PlayModes),
        29: range("glide", 0, 0, 1, "linear", "s")
    })
