import {Procedure} from "@opendaw/lib-std"
import type {Matchering} from "./Matchering"

export interface MatcheringProtocol {
    analyseReference(wasmUrl: string, left: Float32Array, right: Float32Array): Promise<Matchering.ReferenceProfile>
    matchTarget(progress: Procedure<Matchering.Stage>, wasmUrl: string, left: Float32Array, right: Float32Array,
                profile: Matchering.ReferenceProfile): Promise<Matchering.MatchResult>
}
