import {PrimitiveField} from "@moises-ai/lib-box"
import {DefaultParameter, int, StringMapping, ValueMapping} from "@moises-ai/lib-std"
import {NoteEventBox} from "@moises-ai/studio-boxes"
import {PPQN} from "@moises-ai/lib-dsp"

export type OnlyPrimitives<T> = { [K in keyof T as T[K] extends PrimitiveField<number> ? K : never]: T[K] }

export type NotePropertyParameter = {
    parameter: DefaultParameter<number>
    fieldName: keyof OnlyPrimitives<NoteEventBox>
}

export const PropertyParameters = {
    position: {
        parameter: new DefaultParameter<int>(
            ValueMapping.linearInteger(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
            StringMapping.numeric(),
            "Position",
            0),
        fieldName: "position"
    },
    duration: {
        parameter: new DefaultParameter<int>(
            ValueMapping.linearInteger(1, Number.MAX_SAFE_INTEGER),
            StringMapping.numeric(),
            "Duration",
            PPQN.SemiQuaver),
        fieldName: "duration"
    },
    pitch: {
        parameter: new DefaultParameter<int>(
            ValueMapping.linearInteger(0, 127),
            StringMapping.numeric(),
            "Pitch",
            60),
        fieldName: "pitch"
    },
    velocity: {
        parameter: new DefaultParameter<number>(
            ValueMapping.unipolar(),
            StringMapping.percent(),
            "Velocity",
            0.8),
        fieldName: "velocity"
    },
    // TODO FineTune should increase or decrease pitch when overflowing (100cents)
    cent: {
        parameter: new DefaultParameter<number>(
            ValueMapping.linear(-50.0, 50.0),
            StringMapping.numeric({
                unit: "cents",
                bipolar: true,
                fractionDigits: 0
            }),
            "Fine Tune",
            0.0),
        fieldName: "cent"
    },
    chance: {
        parameter: new DefaultParameter<number>(
            ValueMapping.linearInteger(1, 100),
            StringMapping.numeric({
                fractionDigits: 0
            }),
            "Chance",
            100),
        fieldName: "chance"
    },
    playCount: {
        parameter: new DefaultParameter<int>(
            ValueMapping.linearInteger(1, 128),
            StringMapping.numeric({fractionDigits: 0}),
            "Play Count",
            1),
        fieldName: "playCount"
    }, playCurve: {
        parameter: new DefaultParameter<int>(
            ValueMapping.bipolar(),
            StringMapping.percent({fractionDigits: 0, bipolar: false}),
            "Play Curve", 0.0),
        fieldName: "playCurve"
    }
} as const satisfies Record<string, NotePropertyParameter>