import {DefaultParameter, int, StringMapping, ValueMapping} from "@opendaw/lib-std"
import {NoteEventBox} from "@opendaw/studio-boxes"
import {NoteEventFeatures} from "@opendaw/studio-adapters"
import {PPQN} from "@opendaw/lib-dsp"

export interface NotePropertyParameter {
    readonly parameter: DefaultParameter<number>
    write(box: NoteEventBox, value: number): void
}

export const PropertyParameters = {
    position: {
        parameter: new DefaultParameter<int>(
            ValueMapping.linearInteger(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
            StringMapping.numeric(),
            "Position",
            0),
        write: (box: NoteEventBox, value: number) => box.position.setValue(value)
    },
    duration: {
        parameter: new DefaultParameter<int>(
            ValueMapping.linearInteger(1, Number.MAX_SAFE_INTEGER),
            StringMapping.numeric(),
            "Duration",
            PPQN.SemiQuaver),
        write: (box: NoteEventBox, value: number) => box.duration.setValue(value)
    },
    pitch: {
        parameter: new DefaultParameter<int>(
            ValueMapping.linearInteger(0, 127),
            StringMapping.numeric(),
            "Pitch",
            60),
        write: (box: NoteEventBox, value: number) => box.pitch.setValue(value)
    },
    velocity: {
        parameter: new DefaultParameter<number>(
            ValueMapping.unipolar(),
            StringMapping.percent(),
            "Velocity",
            0.8),
        write: (box: NoteEventBox, value: number) => box.velocity.setValue(value)
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
        write: (box: NoteEventBox, value: number) => box.cent.setValue(value)
    },
    chance: {
        parameter: new DefaultParameter<number>(
            ValueMapping.linearInteger(1, 100),
            StringMapping.numeric({
                fractionDigits: 0
            }),
            "Chance",
            100),
        write: (box: NoteEventBox, value: number) => NoteEventFeatures.writeChance(box, value)
    },
    playCount: {
        parameter: new DefaultParameter<int>(
            ValueMapping.linearInteger(1, 128),
            StringMapping.numeric({fractionDigits: 0}),
            "Play Count",
            1),
        write: (box: NoteEventBox, value: number) => NoteEventFeatures.writePlayCount(box, value)
    }, playCurve: {
        parameter: new DefaultParameter<int>(
            ValueMapping.bipolar(),
            StringMapping.percent({fractionDigits: 0, bipolar: false}),
            "Play Curve", 0.0),
        write: (box: NoteEventBox, value: number) => NoteEventFeatures.writePlayCurve(box, value)
    }
} as const satisfies Record<string, NotePropertyParameter>