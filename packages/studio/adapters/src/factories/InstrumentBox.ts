import {
    ApparatDeviceBox,
    CubedDeviceBox,
    NeonDeviceBox,
    MIDIOutputDeviceBox,
    NanoDeviceBox,
    InstrumentCompositeBox,
    PlayfieldDeviceBox,
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
    | PlayfieldDeviceBox
    | InstrumentCompositeBox
    | SoundfontDeviceBox
    | MIDIOutputDeviceBox