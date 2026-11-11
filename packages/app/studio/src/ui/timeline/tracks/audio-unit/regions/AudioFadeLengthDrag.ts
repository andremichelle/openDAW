import {clamp, type Editing} from "@opendaw/lib-std"
import type {FadingAdapter} from "@opendaw/studio-adapters"

export const createAudioFadeLengthDrag = (fading: FadingAdapter, duration: number, fadeIn: boolean,
                                          startPointer: number, editing: Editing) => {
    const originalIn = fading.in, originalOut = fading.out
    const originalInSlope = fading.inSlope, originalOutSlope = fading.outSlope
    return {
        update: (pointer: number) => editing.modify(() => {
            if (fadeIn) {
                const length = clamp(originalIn + pointer - startPointer, 0, duration)
                // A newly exposed fade starts straight; existing curves retain their shape.
                if (originalIn === 0) {fading.inSlopeField.setValue(length > 0 ? 0.5 : originalInSlope)}
                fading.inField.setValue(length)
                if (length + fading.out > duration) {fading.outField.setValue(duration - length)}
            } else {
                const length = clamp(originalOut + startPointer - pointer, 0, duration)
                if (originalOut === 0) {fading.outSlopeField.setValue(length > 0 ? 0.5 : originalOutSlope)}
                fading.outField.setValue(length)
                if (fading.in + length > duration) {fading.inField.setValue(duration - length)}
            }
        }, false),
        approve: () => editing.mark(),
        cancel: () => editing.modify(() => {
            fading.inField.setValue(originalIn)
            fading.outField.setValue(originalOut)
            fading.inSlopeField.setValue(originalInSlope)
            fading.outSlopeField.setValue(originalOutSlope)
        })
    }
}
