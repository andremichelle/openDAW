import {Arrays} from "@opendaw/lib-std"

export namespace GroupOverviewLayout {
    export type Region = {position: number, complete: number, hue: number, mute: boolean}
    export type Line = {x: number, y: number, width: number, height: number, hue: number, muted: boolean}

    export const lines = (lanes: ReadonlyArray<ReadonlyArray<Region>>, height: number,
                          width: number, unitToX: (unit: number) => number): ReadonlyArray<Line> => {
        if (lanes.length === 0 || height <= 0 || width <= 0) {return Arrays.empty()}
        const padding = Math.min(4, height / 8)
        const stride = Math.min(10, (height - padding * 2) / lanes.length)
        const thickness = Math.min(5, stride * 0.65)
        return lanes.flatMap((regions, index) => regions.flatMap(region => {
            const x = Math.max(0, unitToX(region.position))
            const end = Math.min(width, unitToX(region.complete))
            return end > x ? [{x, y: padding + index * stride, width: end - x, height: thickness,
                hue: region.hue, muted: region.mute}] : []
        }))
    }
}
