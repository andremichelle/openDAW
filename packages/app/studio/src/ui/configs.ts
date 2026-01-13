import {ValueMapping} from "@moises-ai/lib-std"

export const SnapCenter = {snap: {threshold: 0.5, snapLength: 12}}
export const SnapCommonDecibel = {
    snap: {
        threshold: [-12, -9, -6, -3]
            .map(y => ValueMapping.DefaultDecibel.x(y)), snapLength: 12
    }
}