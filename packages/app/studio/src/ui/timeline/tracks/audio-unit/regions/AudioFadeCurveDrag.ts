import {MetaData, type AudioRegionBoxAdapter} from "@opendaw/studio-adapters"
import type {AudioRegionBox} from "@opendaw/studio-boxes"
import {clamp, type Editing} from "@opendaw/lib-std"
import {AudioFadeHandles} from "./AudioFadeHandles"

const origin = "opendaw.studio.audio-fade-handles"

export const readFadeCurvePositions = (box: AudioRegionBox): {in: number, out: number} => {
    const data = MetaData.read(box, origin)
    const value = (key: string) => {
        const entry = data !== null && typeof data === "object" && !Array.isArray(data) ? data[key] : undefined
        return typeof entry === "number" && Number.isFinite(entry) ? clamp(entry, 0.02, 0.98) : 0.5
    }
    return {in: value("in"), out: value("out")}
}

export const createAudioFadeCurveDrag = (region: AudioRegionBoxAdapter, fadeIn: boolean,
                                         width: number, height: number, editing: Editing) => {
    const field = fadeIn ? region.fading.inSlopeField : region.fading.outSlopeField
    const originalSlope = field.getValue()
    const originalData = MetaData.read(region.box, origin)
    const positions = readFadeCurvePositions(region.box)
    const originalPosition = fadeIn ? positions.in : positions.out
    const restore = () => editing.modify(() => {
        field.setValue(originalSlope)
        if (originalData === null) {MetaData.clear(region.box, origin)}
        else {MetaData.store(region.box, originalData, origin)}
    }, false)
    return {
        update: (deltaX: number, deltaY: number) => {
            if (deltaX === 0 && deltaY === 0) {
                restore()
                return
            }
            const point = AudioFadeHandles.curveAfterDrag(originalSlope, originalPosition,
                deltaX, deltaY, width, height, fadeIn)
            editing.modify(() => {
                field.setValue(point.slope)
                MetaData.store(region.box, {...positions, [fadeIn ? "in" : "out"]: point.position}, origin)
            }, false)
        },
        approve: () => editing.mark(),
        cancel: restore
    }
}
