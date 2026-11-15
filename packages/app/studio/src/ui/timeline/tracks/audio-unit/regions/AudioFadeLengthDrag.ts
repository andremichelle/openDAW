import {clamp, Editing} from "@opendaw/lib-std"
import {FadingAdapter} from "@opendaw/studio-adapters"
import {AudioFadeFineMotion} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeFineMotion.ts"

export interface AudioFadeLengthDrag {
    update(pointer: number, fine?: boolean): void
    approve(): void
    cancel(): void
}

export namespace AudioFadeLengthDrag {
    export const create = (fading: FadingAdapter, duration: number, fadeIn: boolean,
                           startPointer: number, editing: Editing): AudioFadeLengthDrag => {
        const originalIn = fading.in, originalOut = fading.out
        const originalInSlope = fading.inSlope, originalOutSlope = fading.outSlope
        const motion = AudioFadeFineMotion.create()
        return {
            update: (pointer: number, fine: boolean = false) => {
                const moved = motion(pointer - startPointer, 0, fine)
                if (moved.isEmpty()) {return}
                const offset = moved.unwrap()
                const original = fadeIn ? originalIn : originalOut
                const rawLength = clamp(original + (fadeIn ? offset.x : -offset.x), 0, duration)
                const length = fine && duration > 0
                    ? AudioFadeFineMotion.snap(rawLength / duration, true) * duration
                    : rawLength
                editing.modify(() => {
                    if (fadeIn) {
                        if (originalIn === 0) {fading.inSlopeField.setValue(length > 0 ? 0.5 : originalInSlope)}
                        fading.inField.setValue(length)
                        if (length + fading.out > duration) {fading.outField.setValue(duration - length)}
                    } else {
                        if (originalOut === 0) {fading.outSlopeField.setValue(length > 0 ? 0.5 : originalOutSlope)}
                        fading.outField.setValue(length)
                        if (fading.in + length > duration) {fading.inField.setValue(duration - length)}
                    }
                }, false)
            },
            approve: () => editing.mark(),
            cancel: () => editing.modify(() => {
                fading.inField.setValue(originalIn)
                fading.outField.setValue(originalOut)
                fading.inSlopeField.setValue(originalInSlope)
                fading.outSlopeField.setValue(originalOutSlope)
            })
        }
    }
}
