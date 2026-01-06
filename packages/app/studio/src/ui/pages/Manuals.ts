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
    {
        type: "folder", label: "General", files: [
            { type: "page", label: "Audio Bus", path: "/manuals/audio-bus" },
            { type: "page", label: "Automation", path: "/manuals/automation" },
            { type: "page", label: "Browser Support", path: "/manuals/browser-support" },
            { type: "page", label: "Cloud Backup", path: "/manuals/cloud-backup" },
            { type: "page", label: "Firefox MIDI", path: "/manuals/firefox-midi" },
            { type: "page", label: "Keyboard Shortcuts", path: "/manuals/keyboard-shortcuts" },
            { type: "page", label: "Mixer", path: "/manuals/mixer" },
            { type: "page", label: "Permissions", path: "/manuals/permissions" },
            { type: "page", label: "Private File System", path: "/manuals/private-file-system" },
            { type: "page", label: "Recording", path: "/manuals/recording" },
            { type: "page", label: "Shadertoy", path: "/manuals/shadertoy" }
        ]
    },
    {
        type: "folder", label: "Devices", files: [
            {
                type: "folder", label: "Audio FX", files: [
                    { type: "page", label: "Cheap Reverb", path: "/manuals/devices/audio/reverb" },
                    { type: "page", label: "Compressor", path: "/manuals/devices/audio/compressor" },
                    { type: "page", label: "Crusher", path: "/manuals/devices/audio/crusher" },
                    { type: "page", label: "Dattorro Reverb", path: "/manuals/devices/audio/dattorro-reverb" },
                    { type: "page", label: "Delay", path: "/manuals/devices/audio/delay" },
                    { type: "page", label: "Fold", path: "/manuals/devices/audio/fold" },
                    { type: "page", label: "Maximizer", path: "/manuals/devices/audio/maximizer" },
                    { type: "page", label: "Revamp", path: "/manuals/devices/audio/revamp" },
                    { type: "page", label: "Stereo Tool", path: "/manuals/devices/audio/stereotool" },
                    { type: "page", label: "Tidal", path: "/manuals/devices/audio/tidal" }
                ]
            },
            {
                type: "folder", label: "Instruments", files: [
                    { type: "page", label: "MIDIOutput", path: "/manuals/devices/instruments/midioutput" },
                    { type: "page", label: "Nano", path: "/manuals/devices/instruments/nano" },
                    { type: "page", label: "Playfield", path: "/manuals/devices/instruments/playfield" },
                    { type: "page", label: "Soundfont", path: "/manuals/devices/instruments/soundfont" },
                    { type: "page", label: "Tape", path: "/manuals/devices/instruments/tape" },
                    { type: "page", label: "Vaporisateur", path: "/manuals/devices/instruments/vaporisateur" }
                ]
            },
            {
                type: "folder", label: "MIDI FX", files: [
                    { type: "page", label: "Arpeggio", path: "/manuals/devices/midi/arpeggio" },
                    { type: "page", label: "Pitch", path: "/manuals/devices/midi/pitch" },
                    { type: "page", label: "Velocity", path: "/manuals/devices/midi/velocity" },
                    { type: "page", label: "Zeitgeist", path: "/manuals/devices/midi/zeitgeist" }
                ]
            }
        ]
    },
    {
        type: "folder", label: "AI Co-Pilot", files: [
            { type: "page", label: "Introduction", path: "/manuals/odie/introduction" },
            { type: "page", label: "Quickstart", path: "/manuals/odie/quickstart" },
            { type: "page", label: "Chat Interface", path: "/manuals/odie/chat-interface" },
            { type: "page", label: "Command Reference", path: "/manuals/odie/command-reference" },
            { type: "page", label: "Odie Academy", path: "/manuals/odie/school-guide" },
            { type: "page", label: "GenUI Features", path: "/manuals/odie/genui-features" },
            { type: "page", label: "Troubleshooting", path: "/manuals/odie/troubleshooting" },
            { type: "page", label: "Free AI Guide", path: "/manuals/odie/free-ai-guide" },
            { type: "page", label: "Local Models", path: "/manuals/odie/local-models" }
        ]
    },
    {
        type: "folder", label: "Developer", files: [
            { type: "page", label: "How to create a device in openDAW?", path: "/manuals/creating-a-device" },
            { type: "page", label: "Tech Stack", path: "/manuals/tech-stack" },
            {
                type: "folder", label: "Odie Architecture", files: [
                    { type: "page", label: "System Overview", path: "/manuals/odie/developer/system-overview" },
                    { type: "page", label: "Dual Brain", path: "/manuals/odie/developer/dual-brain" },
                    { type: "page", label: "App Control Bridge", path: "/manuals/odie/developer/app-control" },
                    { type: "page", label: "GenUI Engine", path: "/manuals/odie/developer/genui-engine" },
                    { type: "page", label: "School Internals", path: "/manuals/odie/developer/odie-school" },
                    { type: "page", label: "Testing & Benchmarks", path: "/manuals/odie/developer/testing" }
                ]
            }
        ]
    }
]