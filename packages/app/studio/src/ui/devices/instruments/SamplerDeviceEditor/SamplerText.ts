// Wording shared by the Sampler's messages and labels.
export namespace SamplerText {
    export const count = (amount: number, one: string, many: string): string => `${amount} ${amount === 1 ? one : many}`
}
