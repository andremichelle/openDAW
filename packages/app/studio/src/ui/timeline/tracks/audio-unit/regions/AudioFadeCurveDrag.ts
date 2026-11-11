import {Editing} from "@opendaw/lib-std"
import {AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {AudioFadeAnchors} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeAnchors.ts"
import {AudioFadeHandles} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeHandles.ts"

export interface AudioFadeCurveDrag {
    update(deltaX: number, deltaY: number): void
    approve(): void
    cancel(): void
}

export const createAudioFadeCurveDrag = (region: AudioRegionBoxAdapter, fadeIn: boolean,
                                         width: number, height: number, editing: Editing): AudioFadeCurveDrag => {
    const field = fadeIn ? region.fading.inSlopeField : region.fading.outSlopeField
    const originalSlope = field.getValue()
    const stored = AudioFadeAnchors.exists(region.box)
    const anchors = AudioFadeAnchors.read(region.box)
    const originalPosition = fadeIn ? anchors.in : anchors.out
    const restore = (mark: boolean) => editing.modify(() => {
        field.setValue(originalSlope)
        if (stored) {AudioFadeAnchors.store(region.box, anchors)} else {AudioFadeAnchors.clear(region.box)}
    }, mark)
    return {
        update: (deltaX: number, deltaY: number) => {
            if (deltaX === 0 && deltaY === 0) {
                restore(false)
                return
            }
            const point = AudioFadeHandles.curveAfterDrag(originalSlope, originalPosition,
                deltaX, deltaY, width, height, fadeIn)
            editing.modify(() => {
                field.setValue(point.slope)
                AudioFadeAnchors.store(region.box, fadeIn ? {...anchors, in: point.position} : {...anchors, out: point.position})
            }, false)
        },
        approve: () => editing.mark(),
        cancel: () => restore(true)
    }
}
