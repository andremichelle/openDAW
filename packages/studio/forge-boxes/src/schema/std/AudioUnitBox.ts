import {AudioSendRouting, AudioUnitType, Pointers} from "@moises-ai/studio-enums"
import {BipolarConstraints, ParameterPointerRules} from "./Defaults"
import {BoxSchema} from "@opendaw/lib-box-forge"

export const AudioUnitBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioUnitBox",
        fields: {
            1: {type: "string", name: "type", value: AudioUnitType.Instrument},
            2: {type: "pointer", name: "collection", pointerType: Pointers.AudioUnits, mandatory: true},
            3: {type: "field", name: "editing", pointerRules: {accepts: [Pointers.Editing], mandatory: false}},
            11: {type: "int32", name: "index", constraints: "index", unit: ""},
            12: {
                type: "float32", name: "volume", pointerRules: ParameterPointerRules,
                constraints: {min: -96.0, mid: -9.0, max: 6.0, scaling: "decibel"}, unit: "dB"
            },
            13: {
                type: "float32", name: "panning", pointerRules: ParameterPointerRules,
                ...BipolarConstraints
            },
            14: {type: "boolean", name: "mute", pointerRules: ParameterPointerRules},
            15: {type: "boolean", name: "solo", pointerRules: ParameterPointerRules},
            20: {
                type: "field",
                name: "tracks",
                pointerRules: {accepts: [Pointers.TrackCollection], mandatory: false}
            },
            21: {
                type: "field",
                name: "midi-effects",
                pointerRules: {accepts: [Pointers.MIDIEffectHost], mandatory: false}
            },
            22: {
                type: "field",
                name: "input",
                pointerRules: {
                    accepts: [Pointers.InstrumentHost, Pointers.AudioOutput],
                    mandatory: false,
                    exclusive: true
                }
            },
            23: {
                type: "field",
                name: "audio-effects",
                pointerRules: {accepts: [Pointers.AudioEffectHost], mandatory: false}
            },
            24: {
                type: "field",
                name: "aux-sends",
                pointerRules: {accepts: [Pointers.AuxSend], mandatory: false}
            },
            25: {
                type: "pointer",
                name: "output",
                pointerType: Pointers.AudioOutput, mandatory: false
            },
            26: {
                type: "pointer",
                name: "capture",
                pointerType: Pointers.Capture, mandatory: false
            }
        } as const
    },
    pointerRules: {
        accepts: [Pointers.Selection, Pointers.Automation, Pointers.MetaData, Pointers.SideChain],
        mandatory: false
    }
}

export const AudioBusBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioBusBox",
        fields: {
            1: {type: "pointer", name: "collection", pointerType: Pointers.AudioBusses, mandatory: true},
            2: {type: "pointer", name: "output", pointerType: Pointers.AudioOutput, mandatory: true},
            3: {
                type: "field",
                name: "input",
                pointerRules: {accepts: [Pointers.AudioOutput], mandatory: false}
            },
            4: {type: "boolean", name: "enabled", value: true},
            5: {type: "string", name: "icon"},
            6: {type: "string", name: "label"},
            7: {type: "string", name: "color", value: "red"},
            8: {type: "boolean", name: "minimized"}
        }
    }, pointerRules: {accepts: [Pointers.SideChain], mandatory: false}
}

export const AuxSendBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AuxSendBox",
        fields: {
            1: {type: "pointer", name: "audio-unit", pointerType: Pointers.AuxSend, mandatory: true},
            2: {type: "pointer", name: "target-bus", pointerType: Pointers.AudioOutput, mandatory: true},
            3: {type: "int32", name: "index", constraints: "index", unit: ""},
            4: {
                type: "int32", name: "routing",
                value: AudioSendRouting.Post,
                constraints: {values: [AudioSendRouting.Pre, AudioSendRouting.Post]},
                unit: ""
            },
            6: {
                type: "float32", name: "send-pan", pointerRules: ParameterPointerRules,
                constraints: "bipolar", unit: ""
            },
            5: {
                type: "float32", name: "send-gain", pointerRules: ParameterPointerRules,
                constraints: "decibel", unit: "dB"
            }
        }
    }, pointerRules: {accepts: [Pointers.SideChain], mandatory: false}
}