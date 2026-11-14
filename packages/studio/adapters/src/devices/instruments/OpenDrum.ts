import {int, StringMapping, ValueMapping} from "@opendaw/lib-std"

/** What every openDrum device shares: its choices and how its values print. */
export namespace OpenDrum {
    export const PlayModes: ReadonlyArray<string> = ["Mono", "Poly", "Gate"]
    export const RumbleLengths: ReadonlyArray<string> = ["1/16", "1/8", "1/4", "1/2", "1/1"]
    export const choice = (names: ReadonlyArray<string>): ValueMapping<int> =>
        ValueMapping.linearInteger(0, names.length - 1)
    export const Strings = {
        hertz: StringMapping.numeric({unit: "Hz", unitPrefix: true, fractionDigits: 1}),
        semitones: StringMapping.numeric({unit: "st", fractionDigits: 1}),
        seconds: StringMapping.numeric({unit: "s", unitPrefix: true, fractionDigits: 1}),
        percent: StringMapping.percent({fractionDigits: 0}),
        decibel: StringMapping.numeric({unit: "dB", fractionDigits: 1})
    } as const
}
