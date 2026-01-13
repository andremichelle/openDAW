import {
    MIDIOutputDeviceBox,
    NanoDeviceBox,
    PlayfieldDeviceBox,
    SoundfontDeviceBox,
    TapeDeviceBox,
    VaporisateurDeviceBox
} from "@moises-ai/studio-boxes"

export type InstrumentBox =
    | TapeDeviceBox
    | VaporisateurDeviceBox
    | NanoDeviceBox
    | PlayfieldDeviceBox
    | SoundfontDeviceBox
    | MIDIOutputDeviceBox