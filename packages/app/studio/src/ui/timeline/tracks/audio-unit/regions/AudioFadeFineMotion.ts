import {Option, Point} from "@opendaw/lib-std"

export namespace AudioFadeFineMotion {
    const FineScale = 0.2
    const SnapRadius = 0.02
    const Detents: ReadonlyArray<number> = [0.25, 0.5, 0.75]

    // the pointer travel with every stretch moved in fine mode counted at a fifth, None while the pointer rests
    export const create = (): (x: number, y: number, fine: boolean) => Option<Point> => {
        const last: Point = {x: 0, y: 0}
        const offset: Point = {x: 0, y: 0}
        return (x: number, y: number, fine: boolean) => {
            if (x === last.x && y === last.y) {return Option.None}
            const scale = fine ? FineScale : 1.0
            offset.x += (x - last.x) * scale
            offset.y += (y - last.y) * scale
            last.x = x
            last.y = y
            return Option.wrap({x: offset.x, y: offset.y})
        }
    }

    export const snap = (value: number, fine: boolean): number =>
        fine ? Detents.find(detent => Math.abs(value - detent) <= SnapRadius) ?? value : value
}
