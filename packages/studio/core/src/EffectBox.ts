import {
    ArpeggioDeviceBox,
    AudioEffectCompositeBox,
    AutotuneDeviceBox,
    MaximizerDeviceBox,
    StereoCompositeBox,
    CompressorDeviceBox,
    CrusherDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    FoldDeviceBox,
    GateDeviceBox,
    ModularDeviceBox,
    NeuralAmpDeviceBox,
    PitchDeviceBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    StereoToolDeviceBox,
    TidalDeviceBox,
    UnknownAudioEffectDeviceBox,
    UnknownMidiEffectDeviceBox,
    VelocityDeviceBox,
    VocoderDeviceBox,
    WaveshaperDeviceBox,
    SpielwerkDeviceBox,
    WerkstattDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"

export type EffectBox =
    | ArpeggioDeviceBox | PitchDeviceBox | VelocityDeviceBox | ZeitgeistDeviceBox | UnknownMidiEffectDeviceBox
    | SpielwerkDeviceBox
    | MaximizerDeviceBox | DelayDeviceBox | ReverbDeviceBox | RevampDeviceBox | StereoToolDeviceBox | TidalDeviceBox
    | ModularDeviceBox | UnknownAudioEffectDeviceBox | CompressorDeviceBox | GateDeviceBox
    | AutotuneDeviceBox | CrusherDeviceBox | FoldDeviceBox | DattorroReverbDeviceBox | NeuralAmpDeviceBox | VocoderDeviceBox
    | WaveshaperDeviceBox | WerkstattDeviceBox | AudioEffectCompositeBox | StereoCompositeBox
