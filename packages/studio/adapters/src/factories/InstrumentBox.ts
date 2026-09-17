import {
    ApparatDeviceBox,
    CubedDeviceBox,
    NeonDeviceBox,
    MIDIOutputDeviceBox,
    NanoDeviceBox,
    PlayfieldDeviceBox,
    NanoSampler2DeviceBox,
    SoundfontDeviceBox,
    TapeDeviceBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"

export type InstrumentBox =
    | ApparatDeviceBox
    | CubedDeviceBox
    | TapeDeviceBox
    | VaporisateurDeviceBox
    | NeonDeviceBox
    | NanoDeviceBox
    | NanoSampler2DeviceBox
    | PlayfieldDeviceBox
    | SoundfontDeviceBox
    | MIDIOutputDeviceBox