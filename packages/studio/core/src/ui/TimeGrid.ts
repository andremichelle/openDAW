import {ppqn, PPQN} from "@opendaw/lib-dsp"
import {int, isDefined, Iterables, quantizeFloor} from "@opendaw/lib-std"
import {TimelineRange} from "./TimelineRange"
import {SignatureTrackAdapter} from "@opendaw/studio-adapters"

export namespace TimeGrid {
    export type Signature = [int, int]
    export type SignatureEvent = Readonly<{ position: ppqn, nominator: int, denominator: int }>
    export type Options = { minLength?: number }
    export type Fragment = { bars: int, beats: int, ticks: int, isBar: boolean, isBeat: boolean, pulse: number }
    export type Designer = (fragment: Fragment) => void

    const computeInterval = (nominator: int, denominator: int, unitsPerPixel: ppqn, minLength: number): ppqn => {
        const barPulses = PPQN.fromSignature(nominator, denominator)
        const beatPulses = PPQN.fromSignature(1, denominator)
        let interval = barPulses
        let pixel = interval / unitsPerPixel
        if (pixel > minLength) {
            // scaling down the interval until we hit the minimum length
            while (pixel > minLength) {
                if (interval > barPulses) {
                    // Above bar level: divide by 2
                    interval /= 2
                } else if (interval > beatPulses) {
                    // Between beat and bar level: divide by nominator
                    interval /= nominator
                } else {
                    // Below beat level: divide by 2
                    interval /= 2
                }
                pixel = interval / unitsPerPixel
            }
        }
        if (pixel < minLength) {
            // scaling up the interval until we hit the minimum length
            while (pixel < minLength) {
                if (interval < beatPulses) {
                    // Below beat level: multiply by 2
                    const nextInterval = interval * 2
                    // If doubling exceeds beat level, jump to beat level instead
                    if (nextInterval > beatPulses) {interval = beatPulses} else {interval = nextInterval}
                } else if (interval < barPulses) {
                    // Between beat and bar level: multiply by nominator
                    const nextInterval = interval * nominator
                    // If multiplying exceeds bar level, jump to bar level instead
                    if (nextInterval > barPulses) {interval = barPulses} else {interval = nextInterval}
                } else {
                    // At or above bar level: multiply by 2
                    interval *= 2
                }
                pixel = interval / unitsPerPixel
            }
        }
        return interval
    }

    export const fragment = (signatureTrack: SignatureTrackAdapter,
                             range: TimelineRange, designer: Designer, options?: Options): void => {
        const unitsPerPixel = range.unitsPerPixel
        if (unitsPerPixel <= 0) {return}
        const minLength = options?.minLength ?? 48
        for (const [prev, next] of Iterables.pairWise(signatureTrack.iterateAll())) {
            const {accumulatedPpqn, accumulatedBars, nominator, denominator} = prev
            const interval = computeInterval(prev.nominator, prev.denominator, unitsPerPixel, minLength)
            const p0 = accumulatedPpqn
            const p1 = isDefined(next) ? next.accumulatedPpqn : range.unitMax
            for (let pulse = p0; pulse < p1; pulse += interval) {
                const {bars, beats, semiquavers, ticks} = PPQN.toParts(pulse - accumulatedPpqn, nominator, denominator)
                const isBeat = ticks === 0 && semiquavers === 0
                const isBar = isBeat && beats === 0
                designer({bars: bars + accumulatedBars, beats, ticks, isBar, isBeat, pulse})
            }
        }
    }

    export const fragmentWithSignatures = (
        signatures: Iterable<SignatureEvent>,
        range: TimelineRange,
        designer: Designer,
        options?: Options
    ): void => {
        const unitsPerPixel = range.unitsPerPixel
        if (unitsPerPixel <= 0) {return}
        const minLength = options?.minLength ?? 48

        let accumulatedBars = 0
        let prevPosition: ppqn = 0
        let prevNominator = 4
        let prevDenominator = 4

        const renderSegment = (from: ppqn, to: ppqn, nominator: int, denominator: int, barOffset: int) => {
            const barPulses = PPQN.fromSignature(nominator, denominator)
            const beatPulses = PPQN.fromSignature(1, denominator)

            let interval = barPulses
            let pixel = interval / unitsPerPixel
            if (pixel > minLength) {
                while (pixel > minLength) {
                    if (interval > barPulses) {
                        interval /= 2
                    } else if (interval > beatPulses) {
                        interval /= nominator
                    } else {
                        interval /= 2
                    }
                    pixel = interval / unitsPerPixel
                }
            }
            if (pixel < minLength) {
                while (pixel < minLength) {
                    if (interval < beatPulses) {
                        const nextInterval = interval * 2
                        interval = nextInterval > beatPulses ? beatPulses : nextInterval
                    } else if (interval < barPulses) {
                        const nextInterval = interval * nominator
                        interval = nextInterval > barPulses ? barPulses : nextInterval
                    } else {
                        interval *= 2
                    }
                    pixel = interval / unitsPerPixel
                }
            }

            const segmentStart = Math.max(from, range.unitMin)
            const segmentEnd = Math.min(to, range.unitMax)
            const p0 = quantizeFloor(segmentStart, interval)
            for (let pulse = p0; pulse < segmentEnd; pulse += interval) {
                if (pulse < from) {continue}
                const relativePulse = pulse - from
                const {bars, beats, semiquavers, ticks} = PPQN.toParts(relativePulse, nominator, denominator)
                const isBeat = ticks === 0 && semiquavers === 0
                const isBar = isBeat && beats === 0
                designer({
                    bars: bars + barOffset,
                    beats,
                    ticks,
                    isBar,
                    isBeat,
                    pulse
                })
            }
        }

        for (const sig of signatures) {
            if (sig.position > range.unitMax) {break}

            if (sig.position > prevPosition) {
                const prevBarPulses = PPQN.fromSignature(prevNominator, prevDenominator)
                const barsInSegment = Math.floor((sig.position - prevPosition) / prevBarPulses)
                renderSegment(prevPosition, sig.position, prevNominator, prevDenominator, accumulatedBars)
                accumulatedBars += barsInSegment
            }

            prevPosition = sig.position
            prevNominator = sig.nominator
            prevDenominator = sig.denominator
        }

        renderSegment(prevPosition, range.unitMax, prevNominator, prevDenominator, accumulatedBars)
    }
}