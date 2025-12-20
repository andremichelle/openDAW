import {PPQN} from "@opendaw/lib-dsp"
import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {IndexConstraints, PPQNDurationConstraints, PPQNPositionConstraints} from "../Defaults"

export const TimelineBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "TimelineBox",
        fields: {
            1: {type: "field", name: "root", pointerRules: {accepts: [Pointers.Timeline], mandatory: true}},
            10: {
                type: "object", name: "signature", class: {
                    name: "Signature",
                    fields: {
                        1: {type: "int32", name: "nominator", value: 4, constraints: {min: 1, max: 32}, unit: ""},
                        2: {type: "int32", name: "denominator", value: 4, constraints: {min: 1, max: 32}, unit: ""}
                    }
                }
            },
            11: {
                type: "object", name: "loop-area", class: {
                    name: "LoopArea",
                    fields: {
                        1: {type: "boolean", name: "enabled", value: true},
                        2: {
                            type: "int32", name: "from",
                            value: 0, ...PPQNPositionConstraints
                        },
                        3: {
                            type: "int32", name: "to",
                            value: PPQN.fromSignature(4, 1), ...PPQNPositionConstraints
                        }
                    }
                }
            },
            20: { // TODO deprecate
                type: "field",
                name: "deprecated-marker-track",
                pointerRules: {accepts: [Pointers.MarkerTrack], mandatory: false}
            },
            21: {
                type: "object",
                name: "marker-track",
                class: {
                    name: "MarkerTrack",
                    fields: {
                        1: {
                            type: "field",
                            name: "markers",
                            pointerRules: {accepts: [Pointers.MarkerTrack], mandatory: false}
                        },
                        10: {type: "int32", name: "index", ...IndexConstraints},
                        20: {type: "boolean", name: "enabled", value: true}
                    }
                }
            },
            22: {
                type: "object",
                name: "tempo-track",
                class: {
                    name: "TempoTrack",
                    fields: {
                        1: {
                            type: "pointer",
                            name: "events",
                            mandatory: false,
                            pointerType: Pointers.ValueEventCollection
                        },
                        10: {type: "int32", name: "index", ...IndexConstraints},
                        20: {type: "boolean", name: "enabled", value: true}
                    }
                }
            },
            30: {
                type: "int32", name: "durationInPulses",
                value: PPQN.fromSignature(128, 1), ...PPQNDurationConstraints
            },
            31: {
                type: "float32", name: "bpm",
                value: 120.0, constraints: {min: 30.0, max: 999.0, scaling: "exponential"}, unit: "bpm"
            }
        }
    }
}