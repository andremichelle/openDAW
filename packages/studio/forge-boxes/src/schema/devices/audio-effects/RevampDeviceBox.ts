import {BoxSchema, ClassSchema, deprecated} from "@opendaw/lib-box-forge"
import {Pointers} from "@moises-ai/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

const freqConstraints = {min: 20.0, max: 20_000.0, scaling: "exponential"} as const
const qConstraints = {min: 0.01, max: 10.0, scaling: "exponential"} as const
const gainConstraints = {min: -24.0, max: 24.0, scaling: "linear"} as const

const Pass = {
    name: "RevampPass",
    fields: {
        1: {type: "boolean", name: "enabled", pointerRules: ParameterPointerRules},
        10: {
            type: "float32", name: "frequency", pointerRules: ParameterPointerRules,
            constraints: freqConstraints, unit: "Hz"
        },
        11: {
            type: "int32", name: "order", pointerRules: ParameterPointerRules,
            constraints: {length: 4}, unit: ""
        },
        12: {
            type: "float32", name: "q", pointerRules: ParameterPointerRules,
            constraints: qConstraints, unit: ""
        }
    }
} satisfies ClassSchema<Pointers>

const Shelf = {
    name: "RevampShelf",
    fields: {
        1: {type: "boolean", name: "enabled", pointerRules: ParameterPointerRules},
        10: {
            type: "float32", name: "frequency", pointerRules: ParameterPointerRules,
            constraints: freqConstraints, unit: "Hz"
        },
        11: {
            type: "float32", name: "gain", pointerRules: ParameterPointerRules,
            constraints: gainConstraints, unit: "dB"
        }
    }
} satisfies ClassSchema<Pointers>

const Bell = {
    name: "RevampBell",
    fields: {
        1: {type: "boolean", name: "enabled", pointerRules: ParameterPointerRules},
        10: {
            type: "float32", name: "frequency", pointerRules: ParameterPointerRules,
            constraints: freqConstraints, unit: "Hz"
        },
        11: {
            type: "float32", name: "gain", pointerRules: ParameterPointerRules,
            constraints: gainConstraints, unit: "dB"
        },
        12: {
            type: "float32", name: "q", pointerRules: ParameterPointerRules,
            constraints: qConstraints, unit: ""
        }
    }
} satisfies ClassSchema<Pointers>

export const RevampDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("RevampDeviceBox", {
    10: {type: "object", name: "high-pass", class: Pass},
    11: {type: "object", name: "low-shelf", class: Shelf},
    12: {type: "object", name: "low-bell", class: Bell},
    13: {type: "object", name: "mid-bell", class: Bell},
    14: {type: "object", name: "high-bell", class: Bell},
    15: {type: "object", name: "high-shelf", class: Shelf},
    16: {type: "object", name: "low-pass", class: Pass},
    17: {
        type: "float32", name: "gain", pointerRules: ParameterPointerRules,
        constraints: {min: -18.0, max: 18.0, scaling: "linear"}, unit: "db", deprecated
    }
})