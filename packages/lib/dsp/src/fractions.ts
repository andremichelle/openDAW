import {int} from "@moises-ai/lib-std"
import {PPQN, ppqn} from "./ppqn"

export type Fraction = Readonly<[int, int]>

export namespace Fraction {
    export const builder = () => new Builder()
    export const toDouble = ([n, d]: Fraction): number => n / d
    export const toPPQN = ([n, d]: Fraction): ppqn => PPQN.fromSignature(n, d)

    class Builder {
        readonly #list: Array<Fraction> = []

        add(fraction: Fraction): this {
            this.#list.push(fraction)
            return this
        }

        asArray(): ReadonlyArray<Fraction> {return this.#list}
        asAscendingArray(): ReadonlyArray<Fraction> {return this.#list.toSorted((a, b) => toDouble(a) - toDouble(b))}
        asDescendingArray(): ReadonlyArray<Fraction> {return this.#list.toSorted((a, b) => toDouble(b) - toDouble(a))}
    }
}