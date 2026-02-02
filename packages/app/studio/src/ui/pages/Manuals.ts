import {IconSymbol} from "@opendaw/studio-enums"
import {EffectFactories} from "@opendaw/studio-core"
import {InstrumentFactories} from "@opendaw/studio-adapters"

export type Manual = (
    | {
    type: "page"
    label: string
    path: string
    icon?: IconSymbol
}
    | {
    type: "folder"
    label: string
    icon?: IconSymbol
    files: ReadonlyArray<Manual>
}
    ) & { separatorBefore?: boolean }

export const Manuals: ReadonlyArray<Manual> = [
    {
        type: "folder",
        label: "General",
        files: [
            {type: "page", label: "Audio Bus", path: "/manuals/audio-bus"},
            {type: "page", label: "Automation", path: "/manuals/automation"},
            {
                type: "page",
                label: "Browser Support",
                path: "/manuals/browser-support"
            },
            {
                type: "page",
                label: "Cloud Backup",
                path: "/manuals/cloud-backup"
            },
            {
                type: "page",
                label: "Firefox MIDI",
                path: "/manuals/firefox-midi"
            },
            {
                type: "page",
                label: "Keyboard Shortcuts",
                path: "/manuals/keyboard-shortcuts"
            },
            {type: "page", label: "Mixer", path: "/manuals/mixer"},
            {type: "page", label: "Permissions", path: "/manuals/permissions"},
            {
                type: "page",
                label: "Private File System",
                path: "/manuals/private-file-system"
            },
            {type: "page", label: "Recording", path: "/manuals/recording"},
            {type: "page", label: "Shadertoy", path: "/manuals/shadertoy"}
        ]
    },
    {
        type: "folder",
        label: "Devices",
        files: [
            {
                type: "folder",
                label: "Audio FX",
                files: [
                    {
                        type: "page",
                        label: "Cheap Reverb",
                        path: "/manuals/devices/audio/reverb",
                        icon: EffectFactories.Reverb.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Compressor",
                        path: "/manuals/devices/audio/compressor",
                        icon: EffectFactories.Compressor.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Crusher",
                        path: "/manuals/devices/audio/crusher",
                        icon: EffectFactories.Crusher.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Dattorro Reverb",
                        path: "/manuals/devices/audio/dattorro-reverb",
                        icon: EffectFactories.DattorroReverb.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Delay",
                        path: "/manuals/devices/audio/delay",
                        icon: EffectFactories.Delay.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Fold",
                        path: "/manuals/devices/audio/fold",
                        icon: EffectFactories.Fold.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Gate",
                        path: "/manuals/devices/audio/gate",
                        icon: EffectFactories.Gate.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Maximizer",
                        path: "/manuals/devices/audio/maximizer",
                        icon: EffectFactories.Maximizer.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Neural Amp",
                        path: "/manuals/devices/audio/neural-amp",
                        icon: /*EffectFactories.AudioNamed.NeuralAmp.defaultIcon*/ IconSymbol.Rectangle
                    },
                    {
                        type: "page",
                        label: "Revamp",
                        path: "/manuals/devices/audio/revamp",
                        icon: EffectFactories.Revamp.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Stereo Tool",
                        path: "/manuals/devices/audio/stereotool",
                        icon: EffectFactories.StereoTool.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Tidal",
                        path: "/manuals/devices/audio/tidal",
                        icon: EffectFactories.Tidal.defaultIcon
                    }
                ]
            },
            {
                type: "folder",
                label: "Instruments",
                files: [
                    {
                        type: "page",
                        label: "MIDIOutput",
                        path: "/manuals/devices/instruments/midioutput",
                        icon: InstrumentFactories.MIDIOutput.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Nano",
                        path: "/manuals/devices/instruments/nano",
                        icon: InstrumentFactories.Nano.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Playfield",
                        path: "/manuals/devices/instruments/playfield",
                        icon: InstrumentFactories.Playfield.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Soundfont",
                        path: "/manuals/devices/instruments/soundfont",
                        icon: InstrumentFactories.Soundfont.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Tape",
                        path: "/manuals/devices/instruments/tape",
                        icon: InstrumentFactories.Tape.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Vaporisateur",
                        path: "/manuals/devices/instruments/vaporisateur",
                        icon: InstrumentFactories.Vaporisateur.defaultIcon
                    }
                ]
            },
            {
                type: "folder",
                label: "MIDI FX",
                files: [
                    {
                        type: "page",
                        label: "Arpeggio",
                        path: "/manuals/devices/midi/arpeggio",
                        icon: EffectFactories.Arpeggio.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Pitch",
                        path: "/manuals/devices/midi/pitch",
                        icon: EffectFactories.Pitch.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Velocity",
                        path: "/manuals/devices/midi/velocity",
                        icon: EffectFactories.Velocity.defaultIcon
                    },
                    {
                        type: "page",
                        label: "Zeitgeist",
                        path: "/manuals/devices/midi/zeitgeist",
                        icon: EffectFactories.Zeitgeist.defaultIcon
                    }
                ]
            }
        ]
    },
    {
        type: "folder",
        label: "Developer",
        files: [
            {
                type: "page",
                label: "How to create a device in openDAW?",
                path: "/manuals/creating-a-device"
            },
            {type: "page", label: "Tech Stack", path: "/manuals/tech-stack"}
        ]
    }
]
