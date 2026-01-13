import {StringMapping, ValueMapping} from "@moises-ai/lib-std"
import {ClassicWaveform} from "@moises-ai/lib-dsp"

export const VaporisateurSettings = (() => {
    const MIN_CUTOFF = 20.0
    const MAX_CUTOFF = 20_000.0
    const FILTER_ORDER_VALUES = [1, 2, 3, 4]
    const FILTER_ORDER_STRINGS = ["12", "24", "36", "48"]
    const LFO_WAVEFORM_VALUES = [ClassicWaveform.sine, ClassicWaveform.triangle, ClassicWaveform.saw, ClassicWaveform.square]
    const LFO_WAVEFORM_STRINGS = ["Sine", "Triangle", "Saw", "Square"]
    return {
        MIN_CUTOFF,
        MAX_CUTOFF,
        CUTOFF_VALUE_MAPPING: ValueMapping.exponential(MIN_CUTOFF, MAX_CUTOFF),
        CUTOFF_STRING_MAPPING: StringMapping.numeric({unit: "Hz"}),
        FILTER_ORDER_VALUES,
        FILTER_ORDER_STRINGS,
        FILTER_ORDER_VALUE_MAPPING: ValueMapping.values(FILTER_ORDER_VALUES),
        FILTER_ORDER_STRING_MAPPING: StringMapping.values("db", FILTER_ORDER_VALUES, FILTER_ORDER_STRINGS),
        LFO_WAVEFORM_VALUES,
        LFO_WAVEFORM_STRINGS,
        LFO_WAVEFORM_VALUE_MAPPING: ValueMapping.values(LFO_WAVEFORM_VALUES),
        LFO_WAVEFORM_STRING_MAPPING: StringMapping.values("", LFO_WAVEFORM_VALUES, LFO_WAVEFORM_STRINGS)
    }
})()