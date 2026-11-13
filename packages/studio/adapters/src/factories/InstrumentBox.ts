import {
    ApparatDeviceBox,
    CubedDeviceBox,
    KorpusDeviceBox,
    NeonDeviceBox,
    TubularDeviceBox,
    SurgeonDeviceBox,
    MIDIOutputDeviceBox,
    NanoDeviceBox,
    InstrumentCompositeBox,
    PlayfieldDeviceBox,
    SamplerDeviceBox,
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
    | SurgeonDeviceBox
    | NanoDeviceBox
    | PlayfieldDeviceBox
    | SamplerDeviceBox
    | InstrumentCompositeBox
    | SoundfontDeviceBox
    | MIDIOutputDeviceBox