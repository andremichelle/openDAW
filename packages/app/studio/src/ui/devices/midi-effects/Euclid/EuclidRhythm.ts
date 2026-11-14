import {Arrays, clamp, int} from "@opendaw/lib-std"

export namespace EuclidRhythm {
    export type Lane = {
        readonly steps: int
        readonly pulses: int
        readonly rotate: int
        readonly accents: int
        readonly accentRotate: int
        readonly bursts: int
        readonly burstRotate: int
    }
    /** What a step plays: nothing, a hit, an accented hit, and how many triggers when it is a burst. */
    export type Step = { readonly hit: boolean, readonly accent: boolean, readonly burst: boolean }

    // Bjorklund's algorithm, the rhythms of Toussaint's paper (5 of 8 is x.xx.xx.)
    const bjorklund = (steps: int, pulses: int): ReadonlyArray<boolean> => {
        if (pulses === 0) {return Arrays.create(() => false, steps)}
        let groups: Array<Array<boolean>> = Arrays.create(() => [true], pulses)
        let rests: Array<Array<boolean>> = Arrays.create(() => [false], steps - pulses)
        while (rests.length > 1) {
            const count = Math.min(groups.length, rests.length)
            const merged = groups.slice(0, count).map((group, index) => [...group, ...rests[index]])
            const remainder = groups.length > count ? groups.slice(count) : rests.slice(count)
            groups = merged
            rests = remainder
        }
        return [...groups, ...rests].flat()
    }

    /** `pulses` spread as evenly as possible over `steps`, the first on step 0 before `rotate` shifts them right. */
    export const spread = (steps: int, pulses: int, rotate: int): ReadonlyArray<boolean> => {
        const length = Math.max(1, steps)
        const even = bjorklund(length, clamp(pulses, 0, length))
        const offset = ((rotate % length) + length) % length
        return even.map((_, index) => even[(index - offset + length) % length])
    }

    /** Every step of the lane, accents and bursts spread over its hits the way the hits spread over the steps. */
    export const steps = ({steps, pulses, rotate, accents, accentRotate, bursts, burstRotate}: Lane): ReadonlyArray<Step> => {
        const hits = spread(steps, pulses, rotate)
        const count = hits.filter(hit => hit).length
        const accented = spread(count, accents, accentRotate)
        const bursting = spread(count, bursts, burstRotate)
        let index = 0
        return hits.map(hit => {
            if (!hit) {return {hit, accent: false, burst: false}}
            const step = {hit, accent: count > 0 && accented[index], burst: count > 0 && bursting[index]}
            index++
            return step
        })
    }
}
