import {
    ArpeggioDeviceBox,
    AudioEffectCompositeBox,
    AudioSinkDeviceBox,
    AutotuneDeviceBox,
    TunerDeviceBox,
    MaximizerDeviceBox,
    StereoCompositeBox,
    CompressorDeviceBox,
    ConvolverDeviceBox,
    CrusherDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    FoldDeviceBox,
    GateDeviceBox,
    ModularDeviceBox,
    NeuralAmpDeviceBox,
    WclapDeviceBox,
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
    | TunerDeviceBox | AutotuneDeviceBox | ConvolverDeviceBox | CrusherDeviceBox | FoldDeviceBox | DattorroReverbDeviceBox | NeuralAmpDeviceBox | WclapDeviceBox | VocoderDeviceBox
    | AudioSinkDeviceBox
    | WaveshaperDeviceBox | WerkstattDeviceBox | AudioEffectCompositeBox | StereoCompositeBox
