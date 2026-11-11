import {clamp, Editing} from "@opendaw/lib-std"
import {FadingAdapter} from "@opendaw/studio-adapters"

export interface AudioFadeLengthDrag {
    update(pointer: number): void
    approve(): void
    cancel(): void
}

export const createAudioFadeLengthDrag = (fading: FadingAdapter, duration: number, fadeIn: boolean,
                                          startPointer: number, editing: Editing): AudioFadeLengthDrag => {
    const originalIn = fading.in, originalOut = fading.out
    const originalInSlope = fading.inSlope, originalOutSlope = fading.outSlope
    return {
        update: (pointer: number) => editing.modify(() => {
            if (fadeIn) {
                const length = clamp(originalIn + pointer - startPointer, 0, duration)
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
