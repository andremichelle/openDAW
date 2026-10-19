import {LoopableRegion, ppqn} from "@opendaw/lib-dsp"
import {Option, panic} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter, UnionAdapterTypes} from "../UnionAdapterTypes"

export namespace RegionEditing {
    export const cut = <REGION extends AnyRegionBoxAdapter>(region: REGION,
                                                            cut: ppqn,
                                                            consolidate: boolean): Option<REGION> => {
        if (region.position >= cut || cut >= region.complete) {return Option.None}
        if (UnionAdapterTypes.isLoopableRegion(region)) {
            const {position, complete, loopOffset, loopDuration} = region
            region.duration = cut - position
            return Option.wrap(region.copyTo({
                position: cut,
                duration: complete - cut,
                loopOffset: LoopableRegion.loopOffsetAt({position, complete, loopOffset, loopDuration}, cut),
                consolidate
            }) as REGION)
        } else {
            return panic("Not yet implemented")
        }
    }

    export const clip = <REGION extends AnyRegionBoxAdapter>(region: REGION, begin: ppqn, end: ppqn): REGION => {
        if (UnionAdapterTypes.isLoopableRegion(region)) {
            const {position, complete, loopOffset, loopDuration} = region
            if (begin - position <= 0) {return panic(`first part duration will be zero or negative(${begin - position})`)}
            if (complete - end <= 0) {return panic(`second part duration will be zero or negative(${complete - end})`)}
            region.duration = begin - position
            return region.copyTo({
                position: end,
                duration: complete - end,
                loopOffset: LoopableRegion.loopOffsetAt({position, complete, loopOffset, loopDuration}, end)
            }) as REGION
        } else {
            return panic("Not yet implemented")
        }
    }
}