import {int} from "@moises-ai/lib-std"

export interface Convolver {
    readonly irLength: int
    readonly latency: int
    setImpulseResponse(ir: Float32Array): void
    clear(): void
    process(source: Float32Array, target: Float32Array, fromIndex: int, toIndex: int): void
}

export {TimeDomainConvolver} from "./time-domain-convolver"
export {FrequencyDomainConvolver} from "./frequency-domain-convolver"
