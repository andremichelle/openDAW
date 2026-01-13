import {asEnumValue, MutableValueOwner, ValueOwner} from "@moises-ai/lib-std"
import {ppqn, samples, seconds} from "./ppqn"
import {TempoMap} from "./tempo"

export enum TimeBase {
    Musical = "musical", // PPQN
    Seconds = "seconds",
}

/**
 * Converts between musical time (PPQN) and absolute time (seconds/samples) for a specific value.
 * The converter knows the value's native time-base and uses a TempoMap for conversions.
 * Position is passed as a parameter to allow preview positions during drag operations.
 */
export interface TimeBaseConverter {
    toPPQN(position: ppqn): ppqn
    fromPPQN(value: ppqn, position: ppqn): void
    toSeconds(position: ppqn): seconds
    toSamples(position: ppqn, sampleRate: number): samples
    rawValue(): number
    getTimeBase(): TimeBase
}

export namespace TimeBaseConverter {
    export function aware(tempoMap: TempoMap,
                          timeBase: ValueOwner<string>,
                          property: MutableValueOwner<number>): TimeBaseConverter {
        return new TimeBaseAwareConverter(tempoMap, timeBase, property)
    }
}

class TimeBaseAwareConverter implements TimeBaseConverter {
    readonly #tempoMap: TempoMap
    readonly #timeBase: ValueOwner<string>
    readonly #property: MutableValueOwner<number>

    constructor(tempoMap: TempoMap,
                timeBase: ValueOwner<string>,
                property: MutableValueOwner<number>) {
        this.#property = property
        this.#timeBase = timeBase
        this.#tempoMap = tempoMap
    }

    toPPQN(position: ppqn): ppqn {
        const value = this.#property.getValue()
        if (this.getTimeBase() === TimeBase.Musical) {return value}
        const startSeconds = this.#tempoMap.ppqnToSeconds(position)
        const endSeconds = startSeconds + value
        return this.#tempoMap.intervalToPPQN(startSeconds, endSeconds)
    }

    fromPPQN(value: ppqn, position: ppqn): void {
        if (this.getTimeBase() === TimeBase.Musical) {
            this.#property.setValue(value)
        } else {
            const seconds = this.#tempoMap.intervalToSeconds(position, position + value)
            this.#property.setValue(seconds)
        }
    }

    toSeconds(position: ppqn): seconds {
        const value = this.#property.getValue()
        if (this.getTimeBase() === TimeBase.Seconds) {return value}
        return this.#tempoMap.intervalToSeconds(position, position + value)
    }

    toSamples(position: ppqn, sampleRate: number): samples {return this.toSeconds(position) * sampleRate}

    rawValue(): number {return this.#property.getValue()}
    getTimeBase(): TimeBase {return asEnumValue(this.#timeBase.getValue(), TimeBase)}
}

