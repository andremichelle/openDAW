import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, bipolar, choice} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate

export const OpenDrumSnareDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumSnareDeviceBox", "notes", {
        10: range("tune", 171.16, 80, 600, "exponential", "Hz"),
        11: range("ratio", 1.943, 1, 3, "linear", ""),
        12: unipolar("balance", 0.7243),
        13: range("pitch", 2.065, 0, 24, "linear", "st"),
        14: range("sweep", 0.0092, 0.001, 0.1, "exponential", "s"),
        15: range("decay", 0.2093, 0.02, 2, "exponential", "s"),
        16: bipolar("punch", -0.0221),
        17: unipolar("shape", 0),
        18: range("level", -5.3, -48, -3, "linear", "dB"),
        19: range("wire-decay", 0.1944, 0.02, 2, "exponential", "s"),
        20: unipolar("width", 0.46),
        21: bipolar("curve", -0.2745),
        22: unipolar("click", 0.1079),
        23: range("tone", 4779, 200, 16000, "exponential", "Hz"),
        24: unipolar("skin", 0.1612),
        25: range("drive", 0, 0, 36, "linear", "dB"),
        26: range("volume", 0, -36, 6, "linear", "dB"),
        27: unipolar("velocity", 1),
        28: choice("play", 0, PlayModes),
        29: bipolar("panning", 0.0)
    })
