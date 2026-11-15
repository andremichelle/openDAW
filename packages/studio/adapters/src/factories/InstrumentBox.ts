import {
    ApparatDeviceBox,
    CubedDeviceBox,
    KorpusDeviceBox,
    GuitarDeviceBox,
    NeonDeviceBox,
    TubularDeviceBox,
    SurgeonDeviceBox,
    OpenDrumKickDeviceBox,
    OpenDrumPercDeviceBox,
    OpenDrumBellDeviceBox,
    OpenDrumCymbalDeviceBox,
    OpenDrumShakerDeviceBox,
    OpenDrumHatDeviceBox,
    OpenDrumRimDeviceBox,
    OpenDrumTomDeviceBox,
    OpenDrumClapDeviceBox,
    OpenDrumSnareDeviceBox,
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
    | GuitarDeviceBox
    | TapeDeviceBox
    | VaporisateurDeviceBox
    | NeonDeviceBox
    | WclapInstrumentBox
    | TubularDeviceBox
    | SurgeonDeviceBox
    | OpenDrumKickDeviceBox
    | OpenDrumPercDeviceBox
    | OpenDrumBellDeviceBox
    | OpenDrumCymbalDeviceBox
    | OpenDrumShakerDeviceBox
    | OpenDrumHatDeviceBox
    | OpenDrumRimDeviceBox
    | OpenDrumTomDeviceBox
    | OpenDrumClapDeviceBox
    | OpenDrumSnareDeviceBox
    | NanoDeviceBox
    | PlayfieldDeviceBox
    | SamplerDeviceBox
    | InstrumentCompositeBox
    | SoundfontDeviceBox
    | MIDIOutputDeviceBox