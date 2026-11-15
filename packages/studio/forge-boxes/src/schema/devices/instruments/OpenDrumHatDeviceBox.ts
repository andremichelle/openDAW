import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, bipolar, choice} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate

export const OpenDrumHatDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumHatDeviceBox", "notes", {
        10: range("tune", 1, 0.25, 4, "exponential", ""),
        11: range("color", 6300, 200, 16000, "exponential", "Hz"),
        12: range("hold", 0, 0, 0.5, "linear", "s"),
        13: range("decay", 0.13, 0.005, 4, "exponential", "s"),
        14: bipolar("spread", 0),
        15: unipolar("ring", 0),
        16: unipolar("reso", 0),
        17: bipolar("curve", 0),
        18: range("volume", 0, -36, 6, "linear", "dB"),
        19: unipolar("velocity", 1),
        20: choice("play", 0, PlayModes),
        21: bipolar("panning", 0.0)
    })
