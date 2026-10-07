import {
    ApparatDeviceBox,
    CubedDeviceBox,
    KorpusDeviceBox,
    NeonDeviceBox,
    TubularDeviceBox,
    MIDIOutputDeviceBox,
    NanoDeviceBox,
    InstrumentCompositeBox,
    PlayfieldDeviceBox,
    SoundfontDeviceBox,
    TapeDeviceBox,
    VaporisateurDeviceBox,
    WclapInstrumentBox
} from "@opendaw/studio-boxes"

export type InstrumentBox =
    | ApparatDeviceBox
    | CubedDeviceBox
    | KorpusDeviceBox
    | TapeDeviceBox
    | VaporisateurDeviceBox
    | NeonDeviceBox
    | WclapInstrumentBox
    | TubularDeviceBox
    | NanoDeviceBox
    | PlayfieldDeviceBox
    | InstrumentCompositeBox
    | SoundfontDeviceBox
    | MIDIOutputDeviceBox