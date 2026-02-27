import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const RootBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "RootBox",
        fields: {
            1: {type: "pointer", name: "timeline", mandatory: true, pointerType: Pointers.Timeline},
            2: {type: "field", name: "users", pointerRules: {accepts: [Pointers.User], mandatory: true}},
            3: {type: "string", name: "created"},
            4: {type: "pointer", name: "groove", mandatory: true, pointerType: Pointers.Groove},
            5: {
                type: "float32",
                name: "base-frequency",
                constraints: {min: 400, max: 480, scaling: "linear"},
                unit: "Hz",
                value: 440.0
            },
            10: {
                type: "field",
                name: "modular-setups",
                pointerRules: {accepts: [Pointers.ModularSetup], mandatory: false}
            },
            20: {
                type: "field",
                name: "audio-units",
                pointerRules: {accepts: [Pointers.AudioUnits], mandatory: false}
            },
            21: {
                type: "field",
                name: "audio-busses",
                pointerRules: {accepts: [Pointers.AudioBusses], mandatory: false}
            },
            30: {
                type: "field",
                name: "output-device",
                pointerRules: {accepts: [Pointers.AudioOutput], mandatory: true}
            },
            35: {
                type: "field",
                name: "output-midi-devices",
                pointerRules: {accepts: [Pointers.MIDIDevice], mandatory: false}
            },
            40: {
                type: "object",
                name: "piano-mode",
                class: {
                    name: "PianoMode",
                    fields: {
                        1: {
                            type: "int32", name: "keyboard",
                            value: 0, constraints: {length: 4}, unit: ""
                        },
                        2: {
                            type: "float32", name: "time-range-in-quarters",
                            value: 8, constraints: {min: 1, max: 64, scaling: "linear"}, unit: ""
                        },
                        3: {
                            type: "float32", name: "note-scale",
                            value: 1.0, constraints: {min: 0.5, max: 2, scaling: "linear"}, unit: ""
                        },
                        4: {type: "boolean", name: "note-labels", value: false},
                        5: {
                            type: "int32", name: "transpose",
                            value: 0, constraints: {min: -48, max: 48}, unit: "st"
                        }
                    }
                }
            },
            100: {type: "pointer", name: "shadertoy", pointerType: Pointers.Shadertoy, mandatory: false},

            // TODO Move to UserInterfaceBox
            111: {type: "pointer", name: "editing-channel", pointerType: Pointers.Editing, mandatory: false}
        }
    }, pointerRules: {accepts: [Pointers.MetaData], mandatory: false}
}