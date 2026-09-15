import {
    ApparatDeviceBox,
    CubedDeviceBox,
    KorpusDeviceBox,
    NeonDeviceBox,
    MIDIOutputDeviceBox,
    NanoDeviceBox,
    PlayfieldDeviceBox,
    SoundfontDeviceBox,
    TapeDeviceBox,
    VaporisateurDeviceBox
} from "@opendaw/studio-boxes"

export type InstrumentBox =
    | ApparatDeviceBox
    | CubedDeviceBox
    | KorpusDeviceBox
    | TapeDeviceBox
    | VaporisateurDeviceBox
    | NeonDeviceBox
    | NanoDeviceBox
    | PlayfieldDeviceBox
    | SoundfontDeviceBox
    | MIDIOutputDeviceBox