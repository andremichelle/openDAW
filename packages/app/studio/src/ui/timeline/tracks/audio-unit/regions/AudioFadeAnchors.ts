import {clamp, isDefined, unitValue} from "@opendaw/lib-std"
import {MetaData} from "@opendaw/studio-adapters"
import {AudioRegionBox} from "@opendaw/studio-boxes"

export type AudioFadeAnchors = {readonly in: unitValue, readonly out: unitValue}

export namespace AudioFadeAnchors {
    export const Default: AudioFadeAnchors = Object.freeze({in: 0.5, out: 0.5})
    export const Min = 0.02
    export const Max = 0.98
    const origin = "opendaw.studio.audio-fade-anchors.v1"
    const anchor = (value: unknown): unitValue =>
        typeof value === "number" && Number.isFinite(value) ? clamp(value, Min, Max) : 0.5
    export const exists = (box: AudioRegionBox): boolean => isDefined(MetaData.read(box, origin))
    export const read = (box: AudioRegionBox): AudioFadeAnchors => {
        const value = MetaData.read(box, origin)
        if (!isDefined(value) || typeof value !== "object" || Array.isArray(value)) {return Default}
        return {in: anchor(Reflect.get(value, "in")), out: anchor(Reflect.get(value, "out"))}
    }
    export const store = (box: AudioRegionBox, anchors: AudioFadeAnchors): void =>
        MetaData.store(box, {in: anchors.in, out: anchors.out}, origin)
    export const clear = (box: AudioRegionBox): void => MetaData.clear(box, origin)
}
