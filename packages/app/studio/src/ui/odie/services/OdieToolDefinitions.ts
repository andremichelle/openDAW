
import { LLMTool } from "./llm/LLMProvider"

export const OdieTools: LLMTool[] = [
    // --- PROJECT ---
    {
        name: "project_create",
        description: "Create a new empty project.",
        parameters: { type: "object", properties: {}, required: [] }
    },
    {
        name: "project_load",
        description: "Open the project browser to load a save.",
        parameters: { type: "object", properties: {}, required: [] }
    },
    {
        name: "project_export_mix",
        description: "Export the full project mixdown (triggers options dialog).",
        parameters: { type: "object", properties: {}, required: [] }
    },
    {
        name: "project_export_stems",
        description: "Export individual track stems (triggers options dialog).",
        parameters: { type: "object", properties: {}, required: [] }
    },
    // --- TRANSPORT ---
    {
        name: "transport_play",
        description: "Start playback of the project.",
        parameters: { type: "object", properties: {}, required: [] }
    },
    {
        name: "transport_stop",
        description: "Stop playback or pause.",
        parameters: { type: "object", properties: {}, required: [] }
    },
    // --- RECORDING ---
    {
        name: "recording_start",
        description: "Start recording audio (arms track if needed).",
        parameters: {
            type: "object",
            properties: {
                countIn: { type: "boolean", description: "Enable count-in before recording starts (default: true)." }
            },
            required: []
        }
    },
    {
        name: "recording_stop",
        description: "Stop recording audio.",
        parameters: { type: "object", properties: {}, required: [] }
    },
    {
        name: "region_split",
        description: "Splits a region on a specific track at a given time or the current playhead position.",
        parameters: {
            type: "object",
            properties: {
                trackName: {
                    type: "string",
                    description: "The name of the track containing the region to split."
                },
                time: {
                    type: "number",
                    description: "The time (in beats/pulses) to split at. If omitted, uses current playhead position."
                }
            },
            required: ["trackName"]
        }
    },
    {
        name: "region_move",
        description: "Moves a region from a specific time to a new time position.",
        parameters: {
            type: "object",
            properties: {
                trackName: {
                    type: "string",
                    description: "The name of the track containing the region."
                },
                time: {
                    type: "number",
                    description: "The current start time of the region to identify it."
                },
                newTime: {
                    type: "number",
                    description: "The new start time for the region."
                }
            },
            required: ["trackName", "time", "newTime"]
        }
    },
    {
        name: "region_copy",
        description: "Copies a region from a specific time to a new time position on the same track.",
        parameters: {
            type: "object",
            properties: {
                trackName: {
                    type: "string",
                    description: "The name of the track containing the region."
                },
                time: {
                    type: "number",
                    description: "The current start time of the region to identify it."
                },
                newTime: {
                    type: "number",
                    description: "The new start time for the copy."
                }
            },
            required: ["trackName", "time", "newTime"]
        }
    },
    {
        name: "transport_loop",
        description: "Enable or disable the cycle/loop mode.",
        parameters: {
            type: "object",
            properties: {
                enabled: { type: "boolean", description: "True to enable looping, False to disable." }
            },
            required: ["enabled"]
        }
    },
    {
        name: "transport_set_count_in",
        description: "Set the number of bars for the recording count-in.",
        parameters: {
            type: "object",
            properties: {
                bars: { type: "number", description: "Number of bars (1-4)." }
            },
            required: ["bars"]
        }
    },
    {
        name: "transport_set_bpm",
        description: "Set the project tempo (BPM).",
        parameters: {
            type: "object",
            properties: {
                bpm: { type: "number", description: "Tempo, typically between 60 and 200." }
            },
            required: ["bpm"]
        }
    },
    {
        name: "transport_set_time_signature",
        description: "Set the project time signature (e.g. 4/4, 3/4).",
        parameters: {
            type: "object",
            properties: {
                numerator: { type: "number", description: "Beats per bar (e.g. 4)" },
                denominator: { type: "number", description: "Beat value (e.g. 4)" }
            },
            required: ["numerator", "denominator"]
        }
    },

    // --- MIXER ---
    {
        name: "mixer_volume",
        description: "Set the volume of a track in Decibels (dB). Range: -Infinity to +6.0.",
        parameters: {
            type: "object",
            properties: {
                trackName: { type: "string", description: "Exact name of the track (e.g. 'Kick', 'Bass')." },
                db: { type: "number", description: "Volume level in dB. Max 6.0." }
            },
            required: ["trackName", "db"]
        }
    },
    {
        name: "mixer_pan",
        description: "Set the panning of a track. Range: -1.0 (Left) to 1.0 (Right).",
        parameters: {
            type: "object",
            properties: {
                trackName: { type: "string", description: "Exact name of the track." },
                pan: { type: "number", description: "Pan value between -1.0 and 1.0." }
            },
            required: ["trackName", "pan"]
        }
    },
    {
        name: "mixer_mute",
        description: "Mute or Unmute a track.",
        parameters: {
            type: "object",
            properties: {
                trackName: { type: "string", description: "Exact name of the track." },
                muted: { type: "boolean", description: "True to mute, False to unmute." }
            },
            required: ["trackName", "muted"]
        }
    },
    {
        name: "mixer_solo",
        description: "Solo or Unsolo a track.",
        parameters: {
            type: "object",
            properties: {
                trackName: { type: "string", description: "Exact name of the track." },
                soloed: { type: "boolean", description: "True to solo, False to unsolo." }
            },
            required: ["trackName", "soloed"]
        }
    },

    // --- ARRANGEMENT ---
    {
        name: "arrangement_add_track",
        description: "Add a new instrument track to the project.",
        parameters: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    enum: ["synth", "drums", "keys", "nano", "midiout", "tape", "audio", "playfield", "samplers"],
                    description: "The type of instrument: 'synth' (Vaporisateur), 'drums'/'playfield' (Playfield), 'keys'/'soundfont' (Soundfont), 'nano' (Simple Tone), 'tape' (Tape Machine), 'midiout' (External), 'audio' (Empty track)."
                },
                name: { type: "string", description: "Name for the new track (e.g., 'Fat Bass', 'Kick Drum')." }
            },
            required: ["type", "name"]
        }
    },
    {
        name: "arrangement_delete_track",
        description: "Delete an instrument track by name.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name of the track to delete." }
            },
            required: ["name"]
        }
    },
    {
        name: "arrangement_list_tracks",
        description: "Get a list of all current track names.",
        parameters: { type: "object", properties: {}, required: [] }
    },
    {
        name: "arrangement_add_midi_effect",
        description: "Add a MIDI effect (Arpeggiator, etc.) to an instrument track.",
        parameters: {
            type: "object",
            properties: {
                trackName: { type: "string", description: "Name of the instrument track." },
                effectType: {
                    type: "string",
                    enum: ["arpeggio", "pitch", "velocity", "zeitgeist"],
                    description: "The type of MIDI effect to add."
                }
            },
            required: ["trackName", "effectType"]
        }
    },
    {
        name: "arrangement_add_bus",
        description: "Add a new Audio Bus (Aux/Return track) to the project.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name for the new bus (e.g., 'Drum Bus', 'Reverb Aux')." }
            },
            required: ["name"]
        }
    },
    {
        name: "mixer_add_send",
        description: "Add a parallel send from a track to an Aux Bus.",
        parameters: {
            type: "object",
            properties: {
                trackName: { type: "string", description: "Name of the source track." },
                auxName: { type: "string", description: "Name of the target Aux Bus." },
                db: { type: "number", description: "Initial send level in dB (default: -6.0)." }
            },
            required: ["trackName", "auxName"]
        }
    },
    {
        name: "mixer_add_effect",
        description: "Add an audio effect to a track or bus.",
        parameters: {
            type: "object",
            properties: {
                trackName: { type: "string", description: "Name of the track or bus." },
                effectType: {
                    type: "string",
                    enum: ["compressor", "delay", "reverb", "crusher", "stereo", "tidal", "revamp", "fold", "modular", "dattorro"],
                    description: "The type of effect to add."
                }
            },
            required: ["trackName", "effectType"]
        }
    },
    {
        name: "mixer_set_routing",
        description: "Change the main output routing of a track or bus to another bus.",
        parameters: {
            type: "object",
            properties: {
                sourceName: { type: "string", description: "Name of the source track or bus." },
                targetBusName: { type: "string", description: "Name of the target bus (e.g., 'Parallel Synth Bus')." }
            },
            required: ["sourceName", "targetBusName"]
        }
    }
]
