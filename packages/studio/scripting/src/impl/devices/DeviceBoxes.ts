import {BoxGraph, Field} from "@opendaw/lib-box"
import {INVERSE_SQRT_2, int, panic, Unhandled, UUID} from "@opendaw/lib-std"
import {IconSymbol, Pointers} from "@opendaw/studio-enums"
import {
    ArpeggioDeviceBox,
    AudioEffectCompositeBox,
    AudioEffectCompositeCellBox,
    AutotuneDeviceBox,
    CompressorDeviceBox,
    ConvolverDeviceBox,
    CrusherDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    FoldDeviceBox,
    FrequencySplitBox,
    GateDeviceBox,
    GrooveShuffleBox,
    MaximizerDeviceBox,
    NeuralAmpDeviceBox,
    PitchDeviceBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    SpielwerkDeviceBox,
    StereoCompositeBox,
    StereoToolDeviceBox,
    TidalDeviceBox,
    VelocityDeviceBox,
    VocoderDeviceBox,
    WaveshaperDeviceBox,
    WerkstattDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {InstrumentFactories} from "@opendaw/studio-adapters"
import {AudioEffects, Instruments, MIDIEffects} from "../../Api"

export type MIDIEffectBox =
    | ArpeggioDeviceBox | PitchDeviceBox | VelocityDeviceBox | ZeitgeistDeviceBox | SpielwerkDeviceBox

export type AudioEffectBox =
    | AutotuneDeviceBox | CompressorDeviceBox | ConvolverDeviceBox | CrusherDeviceBox | DattorroReverbDeviceBox
    | DelayDeviceBox | FoldDeviceBox | GateDeviceBox | MaximizerDeviceBox | NeuralAmpDeviceBox | RevampDeviceBox
    | ReverbDeviceBox | StereoToolDeviceBox | TidalDeviceBox | VocoderDeviceBox | WaveshaperDeviceBox
    | WerkstattDeviceBox | AudioEffectCompositeBox | StereoCompositeBox | FrequencySplitBox

export namespace DeviceBoxes {
    export const STEREO_ENTRY_LABELS: ReadonlyArray<string> = ["L", "R"]
    export const FREQUENCY_SPLIT_ENTRY_LABELS: ReadonlyArray<string> = ["Low", "Low Mid", "High Mid", "High"]

    export const MIDIEffectLabels: Record<keyof MIDIEffects, string> = {
        Arpeggio: "Arpeggio", Pitch: "Pitch", Velocity: "Velocity", Zeitgeist: "Zeitgeist", Spielwerk: "Spielwerk"
    }

    export const AudioEffectLabels: Record<keyof AudioEffects, string> = {
        Autotune: "Autotune", Compressor: "Compressor", Convolver: "Convolver", Crusher: "Crusher",
        DattorroReverb: "Dattorro Reverb", Delay: "Delay", Fold: "Fold", Gate: "Gate", Maximizer: "Maximizer",
        NeuralAmp: "Tone3000", Revamp: "Revamp", Reverb: "Reverb", StereoTool: "Stereo Tool", Tidal: "Tidal",
        Vocoder: "Vocoder", Waveshaper: "Waveshaper", Werkstatt: "Werkstatt", Composite: "FX Composite",
        StereoSplit: "Stereo Split", FrequencySplit: "Frequency Split"
    }

    export const midiEffectKeyOf = (boxName: string): keyof MIDIEffects => {
        switch (boxName) {
            case "ArpeggioDeviceBox": return "Arpeggio"
            case "PitchDeviceBox": return "Pitch"
            case "VelocityDeviceBox": return "Velocity"
            case "ZeitgeistDeviceBox": return "Zeitgeist"
            case "SpielwerkDeviceBox": return "Spielwerk"
            default: return panic(`Unknown midi-effect box '${boxName}'`)
        }
    }

    export const audioEffectKeyOf = (boxName: string): keyof AudioEffects => {
        switch (boxName) {
            case "AutotuneDeviceBox": return "Autotune"
            case "CompressorDeviceBox": return "Compressor"
            case "ConvolverDeviceBox": return "Convolver"
            case "CrusherDeviceBox": return "Crusher"
            case "DattorroReverbDeviceBox": return "DattorroReverb"
            case "DelayDeviceBox": return "Delay"
            case "FoldDeviceBox": return "Fold"
            case "GateDeviceBox": return "Gate"
            case "MaximizerDeviceBox": return "Maximizer"
            case "NeuralAmpDeviceBox": return "NeuralAmp"
            case "RevampDeviceBox": return "Revamp"
            case "ReverbDeviceBox": return "Reverb"
            case "StereoToolDeviceBox": return "StereoTool"
            case "TidalDeviceBox": return "Tidal"
            case "VocoderDeviceBox": return "Vocoder"
            case "WaveshaperDeviceBox": return "Waveshaper"
            case "WerkstattDeviceBox": return "Werkstatt"
            case "AudioEffectCompositeBox": return "Composite"
            case "StereoCompositeBox": return "StereoSplit"
            case "FrequencySplitBox": return "FrequencySplit"
            default: return panic(`Unknown audio-effect box '${boxName}'`)
        }
    }

    export const instrumentKeyOf = (boxName: string): keyof Instruments => {
        switch (boxName) {
            case "VaporisateurDeviceBox": return "Vaporisateur"
            case "PlayfieldDeviceBox": return "Playfield"
            case "NanoDeviceBox": return "Nano"
            case "SoundfontDeviceBox": return "Soundfont"
            case "MIDIOutputDeviceBox": return "MIDIOutput"
            case "TapeDeviceBox": return "Tape"
            case "NeonDeviceBox": return "Neon"
            case "CubedDeviceBox": return "Cubed"
            case "ApparatDeviceBox": return "Apparat"
            default: return panic(`Unknown instrument box '${boxName}'`)
        }
    }

    export const isMIDIEffectBox = (boxName: string): boolean =>
        ["ArpeggioDeviceBox", "PitchDeviceBox", "VelocityDeviceBox", "ZeitgeistDeviceBox", "SpielwerkDeviceBox"]
            .includes(boxName)

    export const isAudioEffectBox = (boxName: string): boolean =>
        ["AutotuneDeviceBox", "CompressorDeviceBox", "ConvolverDeviceBox", "CrusherDeviceBox",
            "DattorroReverbDeviceBox", "DelayDeviceBox", "FoldDeviceBox", "GateDeviceBox", "MaximizerDeviceBox",
            "NeuralAmpDeviceBox", "RevampDeviceBox", "ReverbDeviceBox", "StereoToolDeviceBox", "TidalDeviceBox",
            "VocoderDeviceBox", "WaveshaperDeviceBox", "WerkstattDeviceBox", "AudioEffectCompositeBox",
            "StereoCompositeBox", "FrequencySplitBox"].includes(boxName)

    export const isInstrumentBox = (boxName: string): boolean =>
        ["VaporisateurDeviceBox", "PlayfieldDeviceBox", "NanoDeviceBox", "SoundfontDeviceBox",
            "MIDIOutputDeviceBox", "TapeDeviceBox", "NeonDeviceBox", "CubedDeviceBox", "ApparatDeviceBox"]
            .includes(boxName)

    export const createInstrument = (boxGraph: BoxGraph,
                                     key: keyof Instruments,
                                     host: Field<Pointers.InstrumentHost | Pointers.AudioOutput>,
                                     label: string) => {
        const factory = InstrumentFactories.Named[key]
        return factory.create(boxGraph, host, label, factory.defaultIcon)
    }

    export const createMIDIEffect = (boxGraph: BoxGraph,
                                     key: keyof MIDIEffects,
                                     host: Field<Pointers.MIDIEffectHost>,
                                     index: int): MIDIEffectBox => {
        const label = MIDIEffectLabels[key]
        switch (key) {
            case "Arpeggio":
                return ArpeggioDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Pitch":
                return PitchDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Velocity":
                return VelocityDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Zeitgeist": {
                const shuffleBox = GrooveShuffleBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue("Shuffle")
                    box.duration.setValue(480)
                })
                return ZeitgeistDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.groove.refer(shuffleBox)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            }
            case "Spielwerk":
                return SpielwerkDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            default:
                return Unhandled(key)
        }
    }

    export const createAudioEffect = (boxGraph: BoxGraph,
                                      key: keyof AudioEffects,
                                      host: Field<Pointers.AudioEffectHost>,
                                      index: int): AudioEffectBox => {
        const label = AudioEffectLabels[key]
        switch (key) {
            case "Autotune":
                return AutotuneDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Compressor":
                return CompressorDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Convolver":
                return ConvolverDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Crusher":
                return CrusherDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "DattorroReverb":
                return DattorroReverbDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Delay":
                return DelayDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                    box.version.setValue(1)
                })
            case "Fold":
                return FoldDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Gate":
                return GateDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Maximizer":
                return MaximizerDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "NeuralAmp":
                return NeuralAmpDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Revamp":
                return RevampDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.highPass.frequency.setInitValue(40.0)
                    box.highPass.order.setInitValue(1)
                    box.highPass.q.setInitValue(Math.SQRT1_2)
                    box.highPass.enabled.setInitValue(true)
                    box.lowShelf.frequency.setInitValue(80.0)
                    box.lowShelf.gain.setInitValue(6)
                    box.lowBell.frequency.setInitValue(120.0)
                    box.lowBell.gain.setInitValue(6)
                    box.lowBell.q.setInitValue(INVERSE_SQRT_2)
                    box.midBell.frequency.setInitValue(640.0)
                    box.midBell.q.setInitValue(INVERSE_SQRT_2)
                    box.midBell.gain.setInitValue(6)
                    box.highBell.frequency.setInitValue(3600.0)
                    box.highBell.q.setInitValue(INVERSE_SQRT_2)
                    box.highBell.gain.setInitValue(6)
                    box.highShelf.frequency.setInitValue(10000.0)
                    box.highShelf.gain.setInitValue(6)
                    box.lowPass.frequency.setInitValue(15000.0)
                    box.lowPass.order.setInitValue(1)
                    box.lowPass.q.setInitValue(Math.SQRT1_2)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Reverb":
                return ReverbDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.preDelay.setInitValue(0.001)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "StereoTool":
                return StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Tidal":
                return TidalDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.depth.setValue(0.75)
                    box.host.refer(host)
                })
            case "Vocoder":
                return VocoderDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Waveshaper":
                return WaveshaperDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Werkstatt":
                return WerkstattDeviceBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "Composite":
                return AudioEffectCompositeBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
            case "StereoSplit": {
                const composite = StereoCompositeBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
                STEREO_ENTRY_LABELS.forEach((label, entryIndex) => createCompositeEntry(boxGraph, composite.entries, entryIndex, label))
                return composite
            }
            case "FrequencySplit": {
                const composite = FrequencySplitBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue(label)
                    box.index.setValue(index)
                    box.host.refer(host)
                })
                FREQUENCY_SPLIT_ENTRY_LABELS.forEach((label, entryIndex) => createCompositeEntry(boxGraph, composite.entries, entryIndex, label))
                return composite
            }
            default:
                return Unhandled(key)
        }
    }

    export const createCompositeEntry = (boxGraph: BoxGraph,
                                         entries: Field<Pointers.AudioEffectCompositeCell>,
                                         index: int,
                                         label: string): AudioEffectCompositeCellBox =>
        AudioEffectCompositeCellBox.create(boxGraph, UUID.generate(), box => {
            box.composite.refer(entries)
            box.index.setValue(index)
            box.label.setValue(label)
        })

    export const iconName = (symbol: IconSymbol): string => IconSymbol.toName(symbol)
}
