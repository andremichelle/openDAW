import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {OpenDrumFields} from "./OpenDrumFields"

const {range, unipolar, bipolar, choice} = OpenDrumFields
const PlayModes = 3 // Mono, Poly, Gate
const RumbleLengths = 5 // 1/16, 1/8, 1/4, 1/2, 1/1

export const OpenDrumKickDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("OpenDrumKickDeviceBox", "notes", {
        10: range("tune", 51.43, 30.0, 120.0, "exponential", "Hz"),
        11: range("pitch", 28.23, 0.0, 48.0, "linear", "st"),
        12: range("sweep", 0.0025, 0.001, 0.2, "exponential", "s"),
        13: range("drift", 4.1, 0.0, 12.0, "linear", "st"),
        14: range("decay", 1.137, 0.02, 6.0, "exponential", "s"),
        15: bipolar("punch", 0.078),
        16: unipolar("shape", 0.001),
        17: unipolar("skin", 0.295),
        18: unipolar("click", 0.034),
        19: range("tone", 873.1, 200.0, 16000.0, "exponential", "Hz"),
        20: unipolar("noise", 0.5),
        21: range("drive", 0.82, 0.0, 36.0, "linear", "dB"),
        22: unipolar("rumble", 0.0),
        23: choice("length", 2, RumbleLengths),
        24: unipolar("duck", 1.0),
        25: unipolar("bright", 0.25),
        26: range("volume", 0.0, -36.0, 6.0, "linear", "dB"),
        27: unipolar("velocity", 1),
        28: choice("play", 0, PlayModes),
        29: bipolar("panning", 0.0)
    })
