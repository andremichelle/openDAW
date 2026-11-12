const FineScale = 0.2
const SnapRadius = 0.02
const Detents = [0.25, 0.5, 0.75] as const

export namespace AudioFadeFineMotion {
    export const create = () => {
        let lastX = 0, lastY = 0
        let offsetX = 0, offsetY = 0
        return (x: number, y: number, fine: boolean) => {
            if (x === lastX && y === lastY) {return undefined}
            const scale = fine ? FineScale : 1
            offsetX += (x - lastX) * scale
            offsetY += (y - lastY) * scale
            lastX = x
            lastY = y
            return {x: offsetX, y: offsetY}
        }
    }

    export const snap = (value: number, fine: boolean): number =>
        fine ? Detents.find(detent => Math.abs(value - detent) <= SnapRadius) ?? value : value
}
