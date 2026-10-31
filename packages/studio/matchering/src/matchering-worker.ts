import {EmptyProcedure, Procedure} from "@opendaw/lib-std"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {MatcheringProtocol} from "./MatcheringProtocol"
import {MatcheringWasm} from "./MatcheringWasm"
import {Matchering} from "./Matchering"

const load = async (wasmUrl: string, progress: Procedure<Matchering.Stage>): Promise<MatcheringWasm> => {
    const response = await fetch(wasmUrl)
    if (!response.ok) {return Promise.reject(new Error(`Could not load '${wasmUrl}' (${response.status})`))}
    return MatcheringWasm.instantiate(await response.arrayBuffer(), progress)
}

Communicator.executor(Messenger.for(self as unknown as Parameters<typeof Messenger.for>[0]).channel("matchering"),
    new class implements MatcheringProtocol {
        async analyseReference(wasmUrl: string, left: Float32Array, right: Float32Array): Promise<Matchering.ReferenceProfile> {
            return (await load(wasmUrl, EmptyProcedure)).analyseReference(left, right)
        }

        async matchTarget(progress: Procedure<Matchering.Stage>, wasmUrl: string, left: Float32Array,
                          right: Float32Array, profile: Matchering.ReferenceProfile): Promise<Matchering.MatchResult> {
            return (await load(wasmUrl, progress)).matchTarget(left, right, profile)
        }
    })
