import {ppqn} from "@moises-ai/lib-dsp"

export interface MutableRegion {
    set position(value: ppqn)
    set duration(value: ppqn)
    set loopOffset(value: ppqn)
    set loopDuration(value: ppqn)
}