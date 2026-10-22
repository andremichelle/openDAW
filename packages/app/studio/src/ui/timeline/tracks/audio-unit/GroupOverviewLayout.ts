export type OverviewRegion = {position: number, complete: number, hue: number, mute: boolean}
export type OverviewLine = {x: number, y: number, width: number, height: number, hue: number, muted: boolean}

/** One stripe per content lane; clip times are clipped to the visible timeline, never merged across colors. */
export const groupOverviewLayout = (lanes: ReadonlyArray<ReadonlyArray<OverviewRegion>>, height: number,
                                    width: number, unitToX: (unit: number) => number): OverviewLine[] => {
    if (lanes.length === 0 || height <= 0 || width <= 0) {return []}
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
