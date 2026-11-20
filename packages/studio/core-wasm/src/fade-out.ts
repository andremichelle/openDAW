import {int} from "@opendaw/lib-std"

export namespace FadeOut {
    export const apply = (channels: ReadonlyArray<Float32Array>, fadeFrames: int): void => {
        for (const channel of channels) {
            const frames = Math.min(fadeFrames, channel.length)
            const offset = channel.length - frames
            for (let index = 0; index < frames; index++) {
                channel[offset + index] *= (frames - 1 - index) / frames
            }
        }
    }
}
