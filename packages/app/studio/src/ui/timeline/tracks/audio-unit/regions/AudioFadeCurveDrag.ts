import {Editing} from "@opendaw/lib-std"
import {AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import {AudioFadeAnchors} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeAnchors.ts"
import {AudioFadeHandles} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeHandles.ts"
import {AudioFadeFineMotion} from "@/ui/timeline/tracks/audio-unit/regions/AudioFadeFineMotion.ts"

export interface AudioFadeCurveDrag {
    update(deltaX: number, deltaY: number, fine?: boolean): void
    approve(): void
    cancel(): void
}

export namespace AudioFadeCurveDrag {
    export const create = (region: AudioRegionBoxAdapter, fadeIn: boolean,
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
        const motion = AudioFadeFineMotion.create()
        return {
            update: (deltaX: number, deltaY: number, fine: boolean = false) => {
                const moved = motion(AudioFadeHandles.SlopeOnCenterAxis ? 0 : deltaX, deltaY, fine)
                if (moved.isEmpty()) {return}
                const offset = moved.unwrap()
                if (offset.x === 0 && offset.y === 0) {
                    restore(false)
                    return
                }
                const point = AudioFadeHandles.curveAfterDrag(originalSlope, originalPosition,
                    offset.x, offset.y, width, height, fadeIn)
                editing.modify(() => {
                    field.setValue(AudioFadeFineMotion.snap(point.slope, fine))
                    if (AudioFadeHandles.SlopeOnCenterAxis) {return}
                    AudioFadeAnchors.store(region.box, fadeIn ? {...anchors, in: point.position} : {...anchors, out: point.position})
                }, false)
            },
            approve: () => editing.mark(),
            cancel: () => restore(true)
        }
    }
}
