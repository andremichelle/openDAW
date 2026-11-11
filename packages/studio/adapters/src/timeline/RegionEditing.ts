import {ppqn} from "@opendaw/lib-dsp"
import {mod, Option, panic} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter, UnionAdapterTypes} from "../UnionAdapterTypes"

export namespace RegionEditing {
    const preserveOuterFades = (left: AnyRegionBoxAdapter, right: AnyRegionBoxAdapter,
                                original: {in: number, out: number} | null): void => {
        if (original !== null && left.type === "audio-region" && right.type === "audio-region") {
            left.fading.inField.setValue(Math.min(original.in, left.duration))
            right.fading.outField.setValue(Math.min(original.out, right.duration))
            left.fading.outField.setValue(0)
            right.fading.inField.setValue(0)
        }
    }

    export const cut = <REGION extends AnyRegionBoxAdapter>(region: REGION,
                                                            cut: ppqn,
                                                            consolidate: boolean): Option<REGION> => {
        if (region.position >= cut || cut >= region.complete) {return Option.None}
        if (UnionAdapterTypes.isLoopableRegion(region)) {
            const {position, complete, loopOffset, loopDuration} = region
            const fades = region.type === "audio-region" ? {in: region.fading.in, out: region.fading.out} : null
            region.duration = cut - position
            const right = region.copyTo({
                position: cut,
                duration: complete - cut,
                loopOffset: mod(loopOffset + (cut - position), loopDuration),
                consolidate
            }) as REGION
            preserveOuterFades(region, right, fades)
            return Option.wrap(right)
        } else {
            return panic("Not yet implemented")
        }
    }

    export const clip = <REGION extends AnyRegionBoxAdapter>(region: REGION, begin: ppqn, end: ppqn): REGION => {
        if (UnionAdapterTypes.isLoopableRegion(region)) {
            const {position, complete, loopOffset, loopDuration} = region
            if (begin - position <= 0) {return panic(`first part duration will be zero or negative(${begin - position})`)}
            if (complete - end <= 0) {return panic(`second part duration will be zero or negative(${complete - end})`)}
            const fades = region.type === "audio-region" ? {in: region.fading.in, out: region.fading.out} : null
            region.duration = begin - position
            const right = region.copyTo({
                position: end,
                duration: complete - end,
                loopOffset: mod(loopOffset + (end - position), loopDuration)
            }) as REGION
            preserveOuterFades(region, right, fades)
            return right
        } else {
            return panic("Not yet implemented")
        }
    }
}