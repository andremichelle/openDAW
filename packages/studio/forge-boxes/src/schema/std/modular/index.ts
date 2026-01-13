import {createVoltageConnector, ModularBox, ModuleConnectionBox} from "./modules"
import {createModule} from "./builder"
import {Pointers} from "@moises-ai/studio-enums"
import {UnipolarConstraints} from "../Defaults"

export const ModuleDefinitions = [
    ModularBox,
    ModuleConnectionBox,
    ...[
        createModule("ModularAudioInputBox", {10: createVoltageConnector("output")}),
        createModule("ModularAudioOutputBox", {10: createVoltageConnector("input")}),
        createModule("ModuleDelayBox", {
            10: createVoltageConnector("voltage-input"),
            11: createVoltageConnector("voltage-output"),
            20: {
                type: "float32",
                name: "time",
                value: 500,
                constraints: {min: 1, max: 1000, scaling: "exponential"}, unit: "ms",
                pointerRules: {accepts: [Pointers.ParameterController], mandatory: false}
            }
        }),
        createModule("ModuleMultiplierBox", {
            10: createVoltageConnector("voltage-input-x"),
            11: createVoltageConnector("voltage-input-y"),
            12: createVoltageConnector("voltage-output"),
            20: {type: "float32", name: "multiplier", ...UnipolarConstraints}
        }),
        createModule("ModuleGainBox", {
            10: createVoltageConnector("voltage-input"),
            12: createVoltageConnector("voltage-output"),
            20: {
                type: "float32", name: "gain",
                pointerRules: {accepts: [Pointers.ParameterController], mandatory: false},
                constraints: "decibel", unit: "dB"
            }
        })
    ]
]