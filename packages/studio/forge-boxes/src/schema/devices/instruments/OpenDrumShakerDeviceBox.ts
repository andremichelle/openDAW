import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, bipolar, choice} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate

export const OpenDrumShakerDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumShakerDeviceBox", "notes", {
        10: range("color", 7200, 200, 16000, "exponential", "Hz"),
        11: range("attack", 0.02, 0, 0.2, "linear", "s"),
        12: range("decay", 0.012, 0.002, 2, "exponential", "s"),
        13: bipolar("curve", 0.3),
        14: range("volume", 0, -36, 6, "linear", "dB"),
        15: unipolar("velocity", 1),
        16: choice("play", 0, PlayModes),
        17: bipolar("panning", 0.0)
    })
