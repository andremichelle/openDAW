import {Option} from "@opendaw/lib-std"
import {AudioInfo} from "./audio-data"
import {PcmData} from "./pcm-data"
import {dbToGain} from "./utils"

// What a stored sample can become when it is rewritten as 16 bit.
export namespace SampleConversion {
    // "sixteen": is 16 bit already. "exact": every value survives, nothing is lost. "rounding": stays below full
    // scale and is rounded to the nearest step. "scaling": up to Headroom above full scale, lowered to full scale
    // and rounded. "float": louder than that, stays as it is.
    export type Kind = "sixteen" | "exact" | "rounding" | "scaling" | "float"
    export type Verdict = { readonly kind: Kind, readonly peak: number }

    export const HeadroomDb = 0.1
    export const Headroom = dbToGain(HeadroomDb)
    // the largest value 16 bit holds
    const FullScale = 32_767 / 32_768

    export const judge = (pcm: PcmData): Verdict => {
        if (pcm.format === "int16") {return {kind: "sixteen", peak: peakOf(pcm.frames)}}
        const {exact16, peak} = PcmData.measure(pcm)
        return {kind: exact16 ? "exact" : peak <= 1.0 ? "rounding" : peak <= Headroom ? "scaling" : "float", peak}
    }

    export const isConvertible = (kind: Kind): boolean => kind === "exact" || kind === "rounding" || kind === "scaling"

    // the gain a conversion applies: only a sample above full scale is lowered, to full scale
    export const gainOf = ({kind, peak}: Verdict): number => kind === "scaling" ? FullScale / peak : 1.0

    // the 16 bit frames a conversion writes, none for a sample that stays as it is
    export const convert = (pcm: PcmData): Option<PcmData> => {
        if (pcm.format === "int16") {return Option.None}
        const verdict = judge(pcm)
        return isConvertible(verdict.kind) ? Option.wrap(PcmData.quantize(pcm, gainOf(verdict))) : Option.None
    }

    // the size of the audio file once it holds 16 bit
    export const bytesAfter = ({numberOfFrames, numberOfChannels}: AudioInfo): number => 44 + numberOfFrames * numberOfChannels * 2

    const peakOf = (frames: ReadonlyArray<Int16Array>): number => {
        let peak = 0
        for (const plane of frames) {
            for (let frame = 0; frame < plane.length; frame++) {
                const magnitude = Math.abs(plane[frame])
                if (magnitude > peak) {peak = magnitude}
            }
        }
        return peak / 32_768
    }
}
