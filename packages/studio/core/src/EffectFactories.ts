import {UUID} from "@opendaw/lib-std"
import {
    ArpeggioDeviceBox,
    BrickDeviceBox,
    CompressorDeviceBox,
    CrusherDeviceBox,
    DattorroReverbDeviceBox,
    DelayDeviceBox,
    FoldDeviceBox,
    GrooveShuffleBox,
    ModularAudioInputBox,
    ModularAudioOutputBox,
    ModularBox,
    ModularDeviceBox,
    ModuleConnectionBox,
    PitchDeviceBox,
    RevampDeviceBox,
    ReverbDeviceBox,
    StereoToolDeviceBox,
    TidalDeviceBox,
    VelocityDeviceBox,
    ZeitgeistDeviceBox
} from "@opendaw/studio-boxes"
import {IconSymbol} from "@opendaw/studio-enums"
import {EffectFactory} from "./EffectFactory"
import {EffectParameterDefaults} from "./EffectParameterDefaults"

export namespace EffectFactories {
    export const Arpeggio: EffectFactory = {
        defaultName: "Arpeggio",
        defaultIcon: IconSymbol.Stack,
        description: "Generates rhythmic note sequences from chords",
        manualPage: "manuals/devices/midi/arpeggio",
        separatorBefore: false,
        type: "midi",
        create: ({boxGraph}, hostField, index) => ArpeggioDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Arpeggio")
            box.index.setValue(index)
            box.host.refer(hostField)
        })
    }

    export const Pitch: EffectFactory = {
        defaultName: "Pitch",
        defaultIcon: IconSymbol.Note,
        description: "Shifts the pitch of incoming notes",
        manualPage: "manuals/devices/midi/pitch",
        separatorBefore: false,
        type: "midi",
        create: ({boxGraph}, hostField, index) => PitchDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Pitch")
            box.index.setValue(index)
            box.host.refer(hostField)
        })
    }

    export const Velocity: EffectFactory = {
        defaultName: "Velocity",
        defaultIcon: IconSymbol.Velocity,
        description: "Manipulates the velocity of incoming notes",
        manualPage: "manuals/devices/midi/velocity",
        separatorBefore: false,
        type: "midi",
        create: ({boxGraph}, hostField, index) => VelocityDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Velocity")
            box.index.setValue(index)
            box.host.refer(hostField)
        })
    }

    export const Zeitgeist: EffectFactory = {
        defaultName: "Zeitgeist",
        defaultIcon: IconSymbol.Zeitgeist,
        description: "Distorts space and time",
        manualPage: "manuals/devices/midi/zeitgeist",
        separatorBefore: false,
        type: "midi",
        create: ({boxGraph, rootBoxAdapter}, hostField, index): ZeitgeistDeviceBox => {
            const useGlobal = false // TODO First Zeitgeist should be true
            const shuffleBox = useGlobal
                ? rootBoxAdapter.groove.box
                : GrooveShuffleBox.create(boxGraph, UUID.generate(), box => {
                    box.label.setValue("Shuffle")
                    box.duration.setValue(480)
                })
            return ZeitgeistDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Zeitgeist")
                box.groove.refer(shuffleBox)
                box.index.setValue(index)
                box.host.refer(hostField)
            })
        }
    }

    export const StereoTool: EffectFactory = {
        defaultName: "Stereo Tool",
        defaultIcon: IconSymbol.Stereo,
        description: "Computes a stereo transformation matrix with volume, panning, phase inversion and stereo width.",
        manualPage: "manuals/devices/audio/stereo-tool",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): StereoToolDeviceBox =>
            StereoToolDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Stereo Tool")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Delay: EffectFactory = {
        defaultName: "Delay",
        defaultIcon: IconSymbol.Time,
        description: "Echoes the input signal with time-based repeats",
        manualPage: "manuals/devices/audio/delay",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): DelayDeviceBox =>
            DelayDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Delay")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const DattorroReverb: EffectFactory = {
        defaultName: "Dattorro Reverb",
        defaultIcon: IconSymbol.Dattorro,
        description: "Dense algorithmic reverb based on Dattorro's design, capable of infinite decay",
        manualPage: "manuals/devices/audio/dattorro-reverb",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): DattorroReverbDeviceBox =>
            DattorroReverbDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Dattorro Reverb")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Brick: EffectFactory = {
        defaultName: "Brick",
        defaultIcon: IconSymbol.Brick,
        description: "Brickwall limiter with boost capabilities",
        manualPage: "manuals/devices/audio/brick",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): BrickDeviceBox =>
            BrickDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Brick")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Compressor: EffectFactory = {
        defaultName: "Compressor",
        defaultIcon: IconSymbol.Compressor,
        description: "Reduces the dynamic range by attenuating signals above a threshold",
        manualPage: "manuals/devices/audio/compressor",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): CompressorDeviceBox =>
            CompressorDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Compressor")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Reverb: EffectFactory = {
        defaultName: "Cheap Reverb",
        defaultIcon: IconSymbol.Cube,
        description: "Simulates space and depth with reflections",
        manualPage: "manuals/devices/audio/cheap-reverb",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): ReverbDeviceBox =>
            ReverbDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Reverb")
                box.preDelay.setInitValue(0.001)
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Crusher: EffectFactory = {
        defaultName: "Crusher",
        defaultIcon: IconSymbol.Bug,
        description: "Degrates the audio signal",
        manualPage: "manuals/devices/audio/crusher",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): CrusherDeviceBox =>
            CrusherDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Crusher")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Fold: EffectFactory = {
        defaultName: "Fold",
        defaultIcon: IconSymbol.Fold,
        description: "Folds the signal back into audio-range",
        manualPage: "manuals/devices/audio/fold",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): FoldDeviceBox =>
            FoldDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Fold")
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Tidal: EffectFactory = {
        defaultName: "Tidal",
        defaultIcon: IconSymbol.Tidal,
        description: "Shape rhythm and space through volume and pan.",
        manualPage: "manuals/devices/audio/tidal",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): TidalDeviceBox =>
            TidalDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Tidal")
                box.index.setValue(index)
                box.depth.setValue(0.75)
                box.host.refer(hostField)
            })
    }

    export const Revamp: EffectFactory = {
        defaultName: "Revamp",
        defaultIcon: IconSymbol.EQ,
        description: "Shapes the frequency balance of the sound",
        manualPage: "manuals/devices/audio/revamp",
        separatorBefore: false,
        type: "audio",
        create: ({boxGraph}, hostField, index): RevampDeviceBox =>
            RevampDeviceBox.create(boxGraph, UUID.generate(), box => {
                EffectParameterDefaults.defaultRevampDeviceBox(box)
                box.index.setValue(index)
                box.host.refer(hostField)
            })
    }

    export const Modular: EffectFactory = {
        defaultName: "🔇 Create New Modular Audio Effect (inaudible yet)",
        defaultIcon: IconSymbol.Box,
        description: "",
        manualPage: "manuals/devices/audio/modular",
        separatorBefore: true,
        type: "audio",
        create: ({boxGraph, rootBox, userEditingManager}, hostField, index): ModularDeviceBox => {
            const moduleSetupBox = ModularBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(rootBox.modularSetups)
                box.label.setValue("Modular")
            })
            const modularInput = ModularAudioInputBox.create(boxGraph, UUID.generate(), box => {
                box.attributes.collection.refer(moduleSetupBox.modules)
                box.attributes.label.setValue("Modular Input")
                box.attributes.x.setValue(-256)
                box.attributes.y.setValue(32)
            })
            const modularOutput = ModularAudioOutputBox.create(boxGraph, UUID.generate(), box => {
                box.attributes.collection.refer(moduleSetupBox.modules)
                box.attributes.label.setValue("Modular Output")
                box.attributes.x.setValue(256)
                box.attributes.y.setValue(32)
            })
            ModuleConnectionBox.create(boxGraph, UUID.generate(), box => {
                box.collection.refer(moduleSetupBox.connections)
                box.source.refer(modularInput.output)
                box.target.refer(modularOutput.input)
            })
            userEditingManager.modularSystem.edit(moduleSetupBox.editing)
            return ModularDeviceBox.create(boxGraph, UUID.generate(), box => {
                box.label.setValue("Modular")
                box.modularSetup.refer(moduleSetupBox.device)
                box.index.setValue(index)
                box.host.refer(hostField)
            })
        }
    }

    export const MidiNamed = {Arpeggio, Pitch, Velocity, Zeitgeist}
    export const AudioNamed = {
        StereoTool, Compressor, Delay, Reverb, DattorroReverb, Revamp, Crusher, Fold, Tidal, Brick
    }
    export const MidiList: ReadonlyArray<Readonly<EffectFactory>> = Object.values(MidiNamed)
    export const AudioList: ReadonlyArray<Readonly<EffectFactory>> = Object.values(AudioNamed)
    export const MergedNamed = {...MidiNamed, ...AudioNamed}
    export type MidiEffectKeys = keyof typeof MidiNamed
    export type AudioEffectKeys = keyof typeof AudioNamed
}