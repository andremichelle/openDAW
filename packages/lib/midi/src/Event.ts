import {int} from "@moises-ai/lib-std"

export interface Event<TYPE> {
    readonly ticks: int
    readonly type: TYPE
}