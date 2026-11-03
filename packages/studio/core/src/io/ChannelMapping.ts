import {int} from "@opendaw/lib-std"

// the input channels feeding each side as bits (bit n = input channel n), a mono mapping has no right inputs
export type ChannelMapping = { readonly left: int, readonly right: int }

export namespace ChannelMapping {
    export const MaxInputs = 31
    export const Stereo: ChannelMapping = {left: 0b01, right: 0b10}
    export const MonoMixed: ChannelMapping = {left: 0b11, right: 0}

    export const stereo = (index: int): ChannelMapping => ({left: 1 << index, right: 1 << (index + 1)})
    export const mono = (index: int): ChannelMapping => ({left: 1 << index, right: 0})
    export const equals = (a: ChannelMapping, b: ChannelMapping): boolean => a.left === b.left && a.right === b.right
    export const outputCount = ({right}: ChannelMapping): 1 | 2 => right === 0 ? 1 : 2
    export const inputCount = ({left, right}: ChannelMapping): int => 32 - Math.clz32(left | right)
    export const indices = (mask: int): ReadonlyArray<int> =>
        Array.from({length: 32 - Math.clz32(mask)}, (_, index) => index).filter(index => (mask & (1 << index)) !== 0)
    // inputs the stream does not deliver drop out, a left side left empty takes the first input
    export const fit = ({left, right}: ChannelMapping, available: int): ChannelMapping => {
        const mask = (1 << Math.min(Math.max(available, 1), MaxInputs)) - 1
        const fitted = left & mask
        return {left: fitted === 0 ? 1 : fitted, right: right & mask}
    }
}
