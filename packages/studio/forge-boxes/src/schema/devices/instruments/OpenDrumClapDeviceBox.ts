import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, choice, integer, bipolar} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate

export const OpenDrumClapDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumClapDeviceBox", "notes", {
        10: integer("hands", 4, 1, 8),
        11: range("gap", 0.0115, 0, 0.04, "linear", "s"),
        12: range("last", 0.71, 0.3, 1.5, "linear", ""),
        13: unipolar("spread", 0),
        14: range("attack", 0.00075, 0, 0.005, "linear", "s"),
        15: range("decay", 0.019, 0.002, 0.2, "exponential", "s"),
        16: unipolar("snap", 0.6),
        17: range("drive", 0, 0, 36, "linear", "dB"),
        18: range("tone", 1055, 300, 8000, "exponential", "Hz"),
        19: unipolar("resonance", 1),
        20: range("room", -1.25, -48, 0, "linear", "dB"),
        21: range("room-decay", 0.41, 0.02, 2, "exponential", "s"),
        22: unipolar("tail", 0.5),
        23: range("volume", 0, -36, 6, "linear", "dB"),
        24: unipolar("velocity", 1),
        25: choice("play", 0, PlayModes),
        26: bipolar("panning", 0.0)
    })
