import {ppqn} from "@opendaw/lib-dsp"
import {mod, panic} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter, UnionAdapterTypes} from "../UnionAdapterTypes"

export namespace RegionEditing {
    export const cut = (region: AnyRegionBoxAdapter, cut: ppqn, consolidate: boolean): void => {
        if (region.position >= cut || cut >= region.complete) {return}
        if (UnionAdapterTypes.isLoopableRegion(region)) {
            const {position, complete, loopOffset, loopDuration} = region
            region.duration = cut - position
            region.copyTo({
                position: cut,
                duration: complete - cut,
                loopOffset: mod(loopOffset + (cut - position), loopDuration),
                consolidate
            })
        } else {
            return panic("Not yet implemented")
        }
    }

    export const clip = (region: AnyRegionBoxAdapter, begin: ppqn, end: ppqn): void => {
        if (UnionAdapterTypes.isLoopableRegion(region)) {
            const {position, complete, loopOffset, loopDuration} = region
            if (complete - end <= 0) {return panic(`duration will zero or negative(${complete - end})`)}
            region.duration = begin - position
            region.copyTo({
                position: end,
                duration: complete - end,
                loopOffset: mod(loopOffset + (end - position), loopDuration)
            })
        } else {
            return panic("Not yet implemented")
        }
    }
}