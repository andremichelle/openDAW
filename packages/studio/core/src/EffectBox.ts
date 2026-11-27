import {
    ArpeggioDeviceBox,
    AudioEffectCompositeBox,
    AudioSinkDeviceBox,
    AutotuneDeviceBox,
    MaximizerDeviceBox,
    StereoCompositeBox,
    MidSideCompositeBox,
    CompressorDeviceBox,
    ConvolverDeviceBox,
    CrusherDeviceBox,
    CorrodeDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    FoldDeviceBox,
    GateDeviceBox,
    ModularDeviceBox,
    NeuralAmpDeviceBox,
    NoteFilterDeviceBox,
    ScaleMatrixDeviceBox,
    ChordKeysDeviceBox,
    EuclidDeviceBox,
    WclapDeviceBox,
    WclapMidiEffectBox,
    PitchDeviceBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    StereoToolDeviceBox,
    TidalDeviceBox,
    TunerDeviceBox,
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
    | SpielwerkDeviceBox | WclapMidiEffectBox | NoteFilterDeviceBox | ScaleMatrixDeviceBox | ChordKeysDeviceBox | EuclidDeviceBox
    | MaximizerDeviceBox | DelayDeviceBox | ReverbDeviceBox | RevampDeviceBox | StereoToolDeviceBox | TidalDeviceBox
    | ModularDeviceBox | UnknownAudioEffectDeviceBox | CompressorDeviceBox | GateDeviceBox
    | TunerDeviceBox | AutotuneDeviceBox | ConvolverDeviceBox | CrusherDeviceBox | CorrodeDeviceBox | FoldDeviceBox | DattorroReverbDeviceBox | NeuralAmpDeviceBox | WclapDeviceBox | VocoderDeviceBox
    | AudioSinkDeviceBox
    | WaveshaperDeviceBox | WerkstattDeviceBox | AudioEffectCompositeBox | StereoCompositeBox | MidSideCompositeBox
