import {int} from "@opendaw/lib-std"
import {PPQN} from "@opendaw/lib-dsp"

export namespace GrooveDurations {
    export const Signatures: ReadonlyArray<[int, int]> = [
        [1, 24], [1, 16], [1, 12], [1, 8], [1, 6], [3, 16], [1, 4], [1, 3], [3, 8], [1, 2], [3, 4],
        [1, 1], [2, 1], [3, 1], [4, 1], [6, 1], [8, 1], [12, 1], [16, 1]
    ]
    export const PPQNs: ReadonlyArray<int> = Signatures.map(([n, d]) => PPQN.fromSignature(n, d))
    export const Labels: ReadonlyArray<string> = Signatures.map(([n, d]) =>
        d === 1 ? `${n} ${n === 1 ? "bar" : "bars"}` : `${n}/${d}`)
}
