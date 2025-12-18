export type Manual = {
    type: "page"
    label: string
    path: string
} | {
    type: "folder"
    label: string
    files: ReadonlyArray<Manual>
}

export const Manuals: ReadonlyArray<Manual> = [
    {type: "page", label: "Browser Support", path: "/manuals/browser-support"},
    {type: "page", label: "Cloud Backup", path: "/manuals/cloud-backup"},
    {type: "page", label: "Recording", path: "/manuals/recording"},
    {type: "page", label: "Keyboard Shortcuts", path: "/manuals/keyboard-shortcuts"},
    {type: "page", label: "Private File System", path: "/manuals/private-file-system"},
    {type: "page", label: "Firefox Midi", path: "/manuals/firefox-midi"},
    {type: "page", label: "Permissions", path: "/manuals/permissions"},
    {type: "page", label: "Tech Stack", path: "/manuals/tech-stack"},
    {type: "page", label: "Shadertoy", path: "/manuals/shadertoy"},
    {type: "page", label: "Dev Log", path: "/manuals/dev-log"},
    {
        type: "folder", label: "Devices", files: [
            {
                type: "folder", label: "Instruments", files: [
                    {type: "page", label: "MIDIOutput", path: "/manuals/devices/instruments/midioutput"},
                    {type: "page", label: "Nano", path: "/manuals/devices/instruments/nano"},
                    {type: "page", label: "Playfield", path: "/manuals/devices/instruments/playfield"},
                    {type: "page", label: "Tape", path: "/manuals/devices/instruments/tape"},
                    {type: "page", label: "Vaporisateur", path: "/manuals/devices/instruments/vaporisateur"}
                ]
            },
            {
                type: "folder", label: "MIDI FX", files: [
                    {type: "page", label: "Velocity", path: "/manuals/devices/midi/velocity"}
                ]
            }
        ]
    }
]