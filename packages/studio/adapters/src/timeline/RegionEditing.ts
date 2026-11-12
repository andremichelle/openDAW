import {ppqn} from "@opendaw/lib-dsp"
import {EmptyProcedure, mod, Option, panic, Procedure} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter, UnionAdapterTypes} from "../UnionAdapterTypes"

export namespace RegionEditing {
    const keepOuterFades = (left: AnyRegionBoxAdapter): Procedure<AnyRegionBoxAdapter> => {
        if (left.type !== "audio-region") {return EmptyProcedure}
        const {fading} = left
        const {in: fadeIn, out: fadeOut} = fading
        return right => {
            if (right.type !== "audio-region") {return}
            fading.inField.setValue(Math.min(fadeIn, left.duration))
            fading.outField.setValue(0)
            right.fading.inField.setValue(0)
            right.fading.outField.setValue(Math.min(fadeOut, right.duration))
        }
    }

    export const cut = <REGION extends AnyRegionBoxAdapter>(region: REGION,
                                                            cut: ppqn,
                                                            consolidate: boolean): Option<REGION> => {
        if (region.position >= cut || cut >= region.complete) {return Option.None}
        if (UnionAdapterTypes.isLoopableRegion(region)) {
            const {position, complete, loopOffset, loopDuration} = region
            const applyFades = keepOuterFades(region)
            region.duration = cut - position
            const right = region.copyTo({
                position: cut,
                duration: complete - cut,
                loopOffset: mod(loopOffset + (cut - position), loopDuration),
                consolidate
            }) as REGION
            applyFades(right)
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
            const applyFades = keepOuterFades(region)
            region.duration = begin - position
            const right = region.copyTo({
                position: end,
                duration: complete - end,
                loopOffset: mod(loopOffset + (end - position), loopDuration)
            }) as REGION
            applyFades(right)
            return right
        } else {
            return panic("Not yet implemented")
        }
    }
}