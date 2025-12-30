export type Manual = ({
    type: "page"
    label: string
    path: string
} | {
    type: "folder"
    label: string
    files: ReadonlyArray<Manual>
}) & { separatorBefore?: boolean }

export const Manuals: ReadonlyArray<Manual> = [
    {type: "page", label: "Browser Support", path: "/manuals/browser-support"},
    {type: "page", label: "Keyboard Shortcuts", path: "/manuals/keyboard-shortcuts"},
    {type: "page", label: "Cloud Backup", path: "/manuals/cloud-backup"},
    {type: "page", label: "Recording", path: "/manuals/recording"},
    {type: "page", label: "Mixer", path: "/manuals/mixer"},
    {type: "page", label: "Automation", path: "/manuals/automation"},
    {type: "page", label: "Private File System", path: "/manuals/private-file-system"},
    {type: "page", label: "Firefox Midi", path: "/manuals/firefox-midi"},
    {type: "page", label: "Permissions", path: "/manuals/permissions"},
    {type: "page", label: "Shadertoy", path: "/manuals/shadertoy"},
    {
        type: "folder", label: "Devices", files: [
            {
                type: "folder", label: "Instruments", files: [
                    {type: "page", label: "Vaporisateur", path: "/manuals/devices/instruments/vaporisateur"},
                    {type: "page", label: "Playfield", path: "/manuals/devices/instruments/playfield"},
                    {type: "page", label: "Nano", path: "/manuals/devices/instruments/nano"},
                    {type: "page", label: "Tape", path: "/manuals/devices/instruments/tape"},
                    {type: "page", label: "Soundfont", path: "/manuals/devices/instruments/soundfont"},
                    {type: "page", label: "MIDIOutput", path: "/manuals/devices/instruments/midioutput"}
                ]
            },
            {
                type: "folder", label: "Audio FX", files: [
                    {type: "page", label: "Stereo Tool", path: "/manuals/devices/audio/stereotool"},
                    {type: "page", label: "Compressor", path: "/manuals/devices/audio/compressor"},
                    {type: "page", label: "Delay", path: "/manuals/devices/audio/delay"},
                    {type: "page", label: "Cheap Reverb", path: "/manuals/devices/audio/reverb"},
                    {type: "page", label: "Dattorro Reverb", path: "/manuals/devices/audio/dattorro-reverb"},
                    {type: "page", label: "Revamp", path: "/manuals/devices/audio/revamp"},
                    {type: "page", label: "Crusher", path: "/manuals/devices/audio/crusher"},
                    {type: "page", label: "Fold", path: "/manuals/devices/audio/fold"},
                    {type: "page", label: "Tidal", path: "/manuals/devices/audio/tidal"}
                ]
            },
            {
                type: "folder", label: "MIDI FX", files: [
                    {type: "page", label: "Arpeggio", path: "/manuals/devices/midi/arpeggio"},
                    {type: "page", label: "Pitch", path: "/manuals/devices/midi/pitch"},
                    {type: "page", label: "Velocity", path: "/manuals/devices/midi/velocity"},
                    {type: "page", label: "Zeitgeist", path: "/manuals/devices/midi/zeitgeist"}
                ]
            }
        ]
    },
    {type: "page", label: "Tech Stack", path: "/manuals/tech-stack", separatorBefore: true},
    {type: "page", label: "Dev Log", path: "/manuals/dev-log"},
    {type: "page", label: "How to create a device in openDAW?", path: "/manuals/creating-a-device"}
]