import {Attempt, int} from "@moises-ai/lib-std"
import {Validator} from "./Validator"

export namespace Parsing {
    export const parseTimeSignature = (input: string): Attempt<[int, int], string> => {
        const [first, second] = input.split("/")
        const numerator = parseInt(first, 10)
        const denominator = parseInt(second, 10)
        return Validator.isTimeSignatureValid(numerator, denominator)
    }
}