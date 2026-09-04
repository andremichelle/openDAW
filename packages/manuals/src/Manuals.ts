import {IconSymbol} from "@opendaw/studio-enums"

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
}) & { separatorBefore?: boolean }

export const isManualsIndex = (path: string): boolean => path === "/manuals" || path === "/manuals/"

export const manualsMarkdownHref = (path: string): string =>
    isManualsIndex(path) ? "/manuals/index.md" : `${path}.md`

export const collectManualPages = (
    manuals: ReadonlyArray<Manual> = Manuals
): ReadonlyArray<Extract<Manual, {type: "page"}>> =>
    manuals.flatMap(manual => manual.type === "page" ? [manual] : collectManualPages(manual.files))

export const Manuals: ReadonlyArray<Manual> = [
    {
        type: "folder",
        label: "General",
        files: [
            {type: "page", label: "Introduction", path: "/manuals/introduction"},
            {type: "page", label: "Audio Bus", path: "/manuals/audio-bus"},
            {type: "page", label: "Automation", path: "/manuals/automation"},
            {type: "page", label: "Browser Support", path: "/manuals/browser-support"},
            {type: "page", label: "Capture MIDI", path: "/manuals/capture-midi"},
            {type: "page", label: "Cloud Backup", path: "/manuals/cloud-backup"},
            {type: "page", label: "Connect MIDI Device", path: "/manuals/connect-midi-device"},
            {type: "page", label: "Education", path: "/manuals/education"},
            {type: "page", label: "Firefox MIDI", path: "/manuals/firefox-midi"},
            {type: "page", label: "Freeze AudioUnit", path: "/manuals/freeze-audiounit"},
            {type: "page", label: "Keyboard Shortcuts", path: "/manuals/keyboard-shortcuts"},
            {type: "page", label: "Latency", path: "/manuals/latency"},
            {type: "page", label: "Live Rooms", path: "/manuals/live-rooms"},
            {type: "page", label: "Mixer", path: "/manuals/mixer"},
            {type: "page", label: "Modulation", path: "/manuals/modulation"},
            {type: "page", label: "Nextcloud", path: "/manuals/nextcloud"},
            {type: "page", label: "Open Source", path: "/manuals/open-source"},
            {type: "page", label: "Permissions", path: "/manuals/permissions"},
            {type: "page", label: "Presets", path: "/manuals/presets"},
            {type: "page", label: "Private File System", path: "/manuals/private-file-system"},
            {type: "page", label: "Project Management", path: "/manuals/project-management"},
            {type: "page", label: "Recording", path: "/manuals/recording"},
            {type: "page", label: "Script Editor", path: "/manuals/script-editor"},
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
                    {type: "page", label: "Autotune", path: "/manuals/devices/audio/autotune", icon: IconSymbol.Note},
                    {type: "page", label: "Compressor", path: "/manuals/devices/audio/compressor", icon: IconSymbol.Compressor},
                    {type: "page", label: "Convolver", path: "/manuals/devices/audio/convolver", icon: IconSymbol.Convolver},
                    {type: "page", label: "Crusher", path: "/manuals/devices/audio/crusher", icon: IconSymbol.Bug},
                    {type: "page", label: "Dattorro Reverb", path: "/manuals/devices/audio/dattorro-reverb", icon: IconSymbol.Dattorro},
                    {type: "page", label: "Delay", path: "/manuals/devices/audio/delay", icon: IconSymbol.Time},
                    {type: "page", label: "Fold", path: "/manuals/devices/audio/fold", icon: IconSymbol.Fold},
                    {type: "page", label: "Free Reverb", path: "/manuals/devices/audio/reverb", icon: IconSymbol.Cube},
                    {type: "page", label: "Frequency Split", path: "/manuals/devices/audio/frequency-split", icon: IconSymbol.Charts},
                    {type: "page", label: "FX Composite", path: "/manuals/devices/audio/effect-composite", icon: IconSymbol.Stack},
                    {type: "page", label: "Gate", path: "/manuals/devices/audio/gate", icon: IconSymbol.Gate},
                    {type: "page", label: "Maximizer", path: "/manuals/devices/audio/maximizer", icon: IconSymbol.Volume},
                    {type: "page", label: "Revamp", path: "/manuals/devices/audio/revamp", icon: IconSymbol.EQ},
                    {type: "page", label: "Stereo Split", path: "/manuals/devices/audio/stereo-composite", icon: IconSymbol.Stereo},
                    {type: "page", label: "Stereo Tool", path: "/manuals/devices/audio/stereotool", icon: IconSymbol.Stereo},
                    {type: "page", label: "Tidal", path: "/manuals/devices/audio/tidal", icon: IconSymbol.Tidal},
                    {type: "page", label: "Tone3000", path: "/manuals/devices/audio/neural-amp", icon: IconSymbol.Tone3000},
                    {type: "page", label: "Vocoder", path: "/manuals/devices/audio/vocoder", icon: IconSymbol.Vocoder},
                    {type: "page", label: "Waveshaper", path: "/manuals/devices/audio/waveshaper", icon: IconSymbol.Curve},
                    {type: "page", label: "Werkstatt", path: "/manuals/devices/audio/werkstatt", icon: IconSymbol.Code}
                ]
            },
            {
                type: "folder",
                label: "Instruments",
                files: [
                    {type: "page", label: "Apparat", path: "/manuals/devices/instruments/apparat", icon: IconSymbol.Code},
                    {type: "page", label: "Cubed", path: "/manuals/devices/instruments/cubed", icon: IconSymbol.Cube},
                    {type: "page", label: "MIDIOutput", path: "/manuals/devices/instruments/midioutput", icon: IconSymbol.Midi},
                    {type: "page", label: "Nano", path: "/manuals/devices/instruments/nano", icon: IconSymbol.NanoWave},
                    {type: "page", label: "Neon", path: "/manuals/devices/instruments/neon", icon: IconSymbol.Neon},
                    {type: "page", label: "Playfield", path: "/manuals/devices/instruments/playfield", icon: IconSymbol.Playfield},
                    {type: "page", label: "Soundfont", path: "/manuals/devices/instruments/soundfont", icon: IconSymbol.SoundFont},
                    {type: "page", label: "Tape", path: "/manuals/devices/instruments/tape", icon: IconSymbol.Tape},
                    {type: "page", label: "Vaporisateur", path: "/manuals/devices/instruments/vaporisateur", icon: IconSymbol.Vaporisateur}
                ]
            },
            {
                type: "folder",
                label: "MIDI FX",
                files: [
                    {type: "page", label: "Arpeggio", path: "/manuals/devices/midi/arpeggio", icon: IconSymbol.Stack},
                    {type: "page", label: "Pitch", path: "/manuals/devices/midi/pitch", icon: IconSymbol.Note},
                    {type: "page", label: "Spielwerk", path: "/manuals/devices/midi/spielwerk", icon: IconSymbol.Code},
                    {type: "page", label: "Velocity", path: "/manuals/devices/midi/velocity", icon: IconSymbol.Velocity},
                    {type: "page", label: "Zeitgeist", path: "/manuals/devices/midi/zeitgeist", icon: IconSymbol.Zeitgeist}
                ]
            }
        ]
    },
    {
        type: "folder",
        label: "Developer",
        files: [
            {type: "page", label: "How to create a device in openDAW?", path: "/manuals/creating-a-device"},
            {type: "page", label: "Tech Stack", path: "/manuals/tech-stack"}
        ]
    }
]
