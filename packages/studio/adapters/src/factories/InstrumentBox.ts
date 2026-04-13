import {
    ApparatDeviceBox,
    MIDIOutputDeviceBox,
    NanoDeviceBox,
    PlayfieldDeviceBox,
    SoundfontDeviceBox,
    TapeDeviceBox,
    VaporisateurDeviceBox
} from "@moises-ai/studio-boxes"

export type InstrumentBox =
    | ApparatDeviceBox
    | TapeDeviceBox
    | VaporisateurDeviceBox
    | NanoDeviceBox
    | PlayfieldDeviceBox
    | SoundfontDeviceBox
    | MIDIOutputDeviceBox