import {Option} from "@opendaw/lib-std"
import {AudioInfo} from "./audio-data"
import {PcmData} from "./pcm-data"
import {dbToGain} from "./utils"

// What a stored sample can become when it is rewritten as 16 bit.
export namespace SampleConversion {
    // exact: nothing is lost. rounding: below full scale. scaling: up to Headroom above it. float: stays as it is.
    export type Kind = "sixteen" | "exact" | "rounding" | "scaling" | "float"
    export type Verdict = { readonly kind: Kind, readonly peak: number }

    export const HeadroomDb = 0.1
    export const Headroom = dbToGain(HeadroomDb)
    const FullScale = 32_767 / 32_768

    export const judge = (pcm: PcmData): Verdict => {
        if (pcm.format === "int16") {return {kind: "sixteen", peak: peakOf(pcm.frames)}}
        const {exact16, peak} = PcmData.measure(pcm)
        return {kind: exact16 ? "exact" : peak <= 1.0 ? "rounding" : peak <= Headroom ? "scaling" : "float", peak}
    }

    export const isConvertible = (kind: Kind): boolean => kind === "exact" || kind === "rounding" || kind === "scaling"

    // only a sample above full scale is lowered, to full scale
    export const gainOf = ({kind, peak}: Verdict): number => kind === "scaling" ? FullScale / peak : 1.0

    export const convert = (pcm: PcmData, verdict: Verdict = judge(pcm)): Option<PcmData> => {
        if (pcm.format === "int16") {return Option.None}
        return isConvertible(verdict.kind) ? Option.wrap(PcmData.quantize(pcm, gainOf(verdict))) : Option.None
    }

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
