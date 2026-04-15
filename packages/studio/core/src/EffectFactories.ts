import {UUID} from "@opendaw/lib-std"
import {
    ArpeggioDeviceBox,
    CompressorDeviceBox,
    CrusherDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    FoldDeviceBox,
    GateDeviceBox,
    GrooveShuffleBox,
    MaximizerDeviceBox,
    ModularAudioInputBox,
    ModularAudioOutputBox,
    ModularBox,
    ModularDeviceBox,
    ModuleConnectionBox,
    NeuralAmpDeviceBox,
    PitchDeviceBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    StereoToolDeviceBox,
    TidalDeviceBox,
    SpielwerkDeviceBox,
    VelocityDeviceBox,
    VocoderDeviceBox,
    WaveshaperDeviceBox,
    WerkstattDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {IconSymbol} from "@opendaw/studio-enums"
import {DeviceManualUrls} from "@opendaw/studio-adapters"
import {EffectFactory} from "./EffectFactory"
import {EffectParameterDefaults} from "./EffectParameterDefaults"

export namespace EffectFactories {
    export const Arpeggio: EffectFactory = {
        defaultName: "Arpeggio",
        defaultIcon: IconSymbol.Stack,
        briefDescription: "Arpeggiator",
        description: "Generates rhythmic note sequences from chords",
        manualPage: DeviceManualUrls.Arpeggio,
        separatorBefore: false,
        external: false,
        type: "midi",
        create: ({boxGraph}, hostField, index) =>
            ArpeggioDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Arpeggio")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Pitch: EffectFactory = {
        defaultName: "Pitch",
        defaultIcon: IconSymbol.Note,
        briefDescription: "Pitch Transformer",
        description: "Shifts the pitch of incoming notes",
        manualPage: DeviceManualUrls.Pitch,
        separatorBefore: false,
        external: false,
        type: "midi",
        create: ({boxGraph}, hostField, index) =>
            PitchDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Pitch")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Velocity: EffectFactory = {
        defaultName: "Velocity",
        defaultIcon: IconSymbol.Velocity,
        briefDescription: "Velocity Transformer",
        description: "Manipulates the velocity of incoming notes",
        manualPage: DeviceManualUrls.Velocity,
        separatorBefore: false,
        external: false,
        type: "midi",
        create: ({boxGraph}, hostField, index) =>
            VelocityDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Velocity")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Zeitgeist: EffectFactory = {
        defaultName: "Zeitgeist",
        defaultIcon: IconSymbol.Zeitgeist,
        briefDescription: "Shuffle",
        description: "Distorts space and time",
        manualPage: DeviceManualUrls.Zeitgeist,
        separatorBefore: false,
        external: false,
        type: "midi",
        create: (
            {boxGraph, rootBoxAdapter},
            hostField,
            index
        ): ZeitgeistDeviceBox => {
            const useGlobal = false // TODO First Zeitgeist should be true
            const shuffleBox = useGlobal
                ? rootBoxAdapter.groove.box
                : GrooveShuffleBox.create(boxGraph, UUID.generate(), (box) => {
                    box.label.setValue("Shuffle")
                    box.duration.setValue(480)
                })
            return ZeitgeistDeviceBox.create(
                boxGraph,
                UUID.generate(),
                (box) => {
                    box.label.setValue("Zeitgeist")
                    box.groove.refer(shuffleBox)
                    box.index.setValue(index)
                    box.host.refer(hostField)
                }
            )
        }
    }

    export const Spielwerk: EffectFactory = {
        defaultName: "Spielwerk",
        defaultIcon: IconSymbol.Code,
        briefDescription: "Scriptable FX",
        description: "User-scripted MIDI effect processor",
        manualPage: DeviceManualUrls.Spielwerk,
        separatorBefore: false,
        external: false,
        type: "midi",
        create: ({boxGraph}, hostField, index) =>
            SpielwerkDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Spielwerk")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const StereoTool: EffectFactory = {
        defaultName: "Stereo Tool",
        defaultIcon: IconSymbol.Stereo,
        briefDescription: "Stereo Imaging",
        description: "Computes a stereo transformation matrix with volume, panning, phase inversion and stereo width.",
        manualPage: DeviceManualUrls.StereoTool,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): StereoToolDeviceBox =>
            StereoToolDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Stereo Tool")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Delay: EffectFactory = {
        defaultName: "Delay",
        defaultIcon: IconSymbol.Time,
        briefDescription: "Echo FX",
        description: "Echoes the input signal with time-based repeats",
        manualPage: DeviceManualUrls.Delay,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): DelayDeviceBox =>
            DelayDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Delay")
                box.index.setValue(index)
                box.host.refer(hostField)
                box.version.setValue(1)
            })
    }

    export const DattorroReverb: EffectFactory = {
        defaultName: "Dattorro Reverb",
        defaultIcon: IconSymbol.Dattorro,
        briefDescription: "Reverb",
        description: "Dense algorithmic reverb based on Dattorro's design, capable of infinite decay",
        manualPage: DeviceManualUrls.DattorroReverb,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): DattorroReverbDeviceBox =>
            DattorroReverbDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Dattorro Reverb")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Maximizer: EffectFactory = {
        defaultName: "Maximizer",
        defaultIcon: IconSymbol.Volume,
        briefDescription: "Brickwall Limiter",
        description: "Brickwall limiter with automatic makeup gain",
        manualPage: DeviceManualUrls.Maximizer,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): MaximizerDeviceBox =>
            MaximizerDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Maximizer")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Compressor: EffectFactory = {
        defaultName: "Compressor",
        defaultIcon: IconSymbol.Compressor,
        briefDescription: "Compressor",
        description: "Reduces the dynamic range by attenuating signals above a threshold",
        manualPage: DeviceManualUrls.Compressor,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): CompressorDeviceBox =>
            CompressorDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Compressor")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Gate: EffectFactory = {
        defaultName: "Gate",
        defaultIcon: IconSymbol.Gate,
        briefDescription: "Noise Gate",
        description: "Attenuates signals below a threshold to reduce noise",
        manualPage: DeviceManualUrls.Gate,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): GateDeviceBox =>
            GateDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Gate")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Reverb: EffectFactory = {
        defaultName: "Free Reverb",
        defaultIcon: IconSymbol.Cube,
        briefDescription: "Reverb",
        description: "Simulates space and depth with reflections",
        manualPage: DeviceManualUrls.Reverb,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): ReverbDeviceBox =>
            ReverbDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Reverb")
                box.preDelay.setInitValue(0.001)
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Crusher: EffectFactory = {
        defaultName: "Crusher",
        defaultIcon: IconSymbol.Bug,
        briefDescription: "Bit Crusher",
        description: "Degrates the audio signal",
        manualPage: DeviceManualUrls.Crusher,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): CrusherDeviceBox =>
            CrusherDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Crusher")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Fold: EffectFactory = {
        defaultName: "Fold",
        defaultIcon: IconSymbol.Fold,
        briefDescription: "Wavefolder",
        description: "Folds the signal back into audio-range",
        manualPage: DeviceManualUrls.Fold,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): FoldDeviceBox =>
            FoldDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Fold")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Waveshaper: EffectFactory = {
        defaultName: "Waveshaper",
        defaultIcon: IconSymbol.Curve,
        briefDescription: "Waveshaper",
        description: "Applies nonlinear waveshaping distortion",
        manualPage: DeviceManualUrls.Waveshaper,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): WaveshaperDeviceBox =>
            WaveshaperDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Waveshaper")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Tidal: EffectFactory = {
        defaultName: "Tidal",
        defaultIcon: IconSymbol.Tidal,
        briefDescription: "Tremolo & Autopan",
        description: "Shape rhythm and space through volume and pan.",
        manualPage: DeviceManualUrls.Tidal,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): TidalDeviceBox =>
            TidalDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Tidal")
                box.index.setValue(index)
                box.depth.setValue(0.75)
                box.host.refer(hostField)
            })
    }

    export const Revamp: EffectFactory = {
        defaultName: "Revamp",
        defaultIcon: IconSymbol.EQ,
        briefDescription: "Graphical EQ",
        description: "Shapes the frequency balance of the sound",
        manualPage: DeviceManualUrls.Revamp,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): RevampDeviceBox =>
            RevampDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                EffectParameterDefaults.defaultRevampDeviceBox(box)
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const NeuralAmp: EffectFactory = {
        defaultName: "Tone3000",
        defaultIcon: IconSymbol.Tone3000,
        briefDescription: "Amp Modeler",
        description: "Access thousands of amps, pedals, and cabs captured with Neural Amp Modeler.",
        manualPage: DeviceManualUrls.NeuralAmp,
        separatorBefore: false,
        external: true,
        type: "audio",
        create: ({boxGraph}, hostField, index): NeuralAmpDeviceBox =>
            NeuralAmpDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Tone3000")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Vocoder: EffectFactory = {
        defaultName: "Vocoder",
        defaultIcon: IconSymbol.EQ,
        briefDescription: "Vocoder",
        description: "Classic analysis/synthesis vocoder with independent carrier and modulator ranges.",
        manualPage: DeviceManualUrls.Vocoder,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): VocoderDeviceBox =>
            VocoderDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Vocoder")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Werkstatt: EffectFactory = {
        defaultName: "Werkstatt",
        defaultIcon: IconSymbol.Code,
        briefDescription: "Scriptable FX",
        description: "User-scripted DSP processor",
        manualPage: DeviceManualUrls.Werkstatt,
        separatorBefore: false,
        external: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): WerkstattDeviceBox =>
            WerkstattDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Werkstatt")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Modular: EffectFactory = {
        defaultName: "🔇 Create New Modular Audio Effect (inaudible yet)",
        defaultIcon: IconSymbol.Box,
        briefDescription: "Modular System",
        description: "",
        manualPage: DeviceManualUrls.Modular,
        separatorBefore: true,
        external: false,
        type: "audio",
        create: ({boxGraph, rootBox, userEditingManager}, hostField, index): ModularDeviceBox => {
            const moduleSetupBox = ModularBox.create(
                boxGraph,
                UUID.generate(),
                (box) => {
                    box.collection.refer(rootBox.modularSetups)
                    box.label.setValue("Modular")
                }
            )
            const modularInput = ModularAudioInputBox.create(
                boxGraph,
                UUID.generate(),
                (box) => {
                    box.attributes.collection.refer(moduleSetupBox.modules)
                    box.attributes.label.setValue("Modular Input")
                    box.attributes.x.setValue(-256)
                    box.attributes.y.setValue(32)
                }
            )
            const modularOutput = ModularAudioOutputBox.create(
                boxGraph,
                UUID.generate(),
                (box) => {
                    box.attributes.collection.refer(moduleSetupBox.modules)
                    box.attributes.label.setValue("Modular Output")
                    box.attributes.x.setValue(256)
                    box.attributes.y.setValue(32)
                }
            )
            ModuleConnectionBox.create(boxGraph, UUID.generate(), (box) => {
                box.collection.refer(moduleSetupBox.connections)
                box.source.refer(modularInput.output)
                box.target.refer(modularOutput.input)
            })
            userEditingManager.modularSystem.edit(moduleSetupBox.editing)
            return ModularDeviceBox.create(boxGraph, UUID.generate(), (box) => {
                box.label.setValue("Modular")
                box.modularSetup.refer(moduleSetupBox.device)
                box.index.setValue(index)
                box.host.refer(hostField)
            })
        }
    }

    export const MidiNamed = {
        Arpeggio,
        Pitch,
        Spielwerk,
        Velocity,
        Zeitgeist
    }

    export const AudioNamed = {
        Compressor,
        Crusher,
        DattorroReverb,  // Dattorro Reverb
        Delay,
        Fold,
        Reverb,          // Free Reverb
        Gate,
        Maximizer,
        Revamp,
        StereoTool,      // Stereo Tool
        Tidal,
        NeuralAmp,       // Tone3000
        Vocoder,
        Waveshaper,
        Werkstatt
    }
    export const MidiList: ReadonlyArray<Readonly<EffectFactory>> =
        Object.values(MidiNamed)
    export const AudioList: ReadonlyArray<Readonly<EffectFactory>> =
        Object.values(AudioNamed)
    export const MergedNamed = {...MidiNamed, ...AudioNamed}
    export type MidiEffectKeys = keyof typeof MidiNamed
    export type AudioEffectKeys = keyof typeof AudioNamed
}
