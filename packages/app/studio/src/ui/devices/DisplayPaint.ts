import {Color} from "@opendaw/lib-std"

export namespace DisplayPaint {
    const base = new Color(200, 83, 60)
    const grid = new Color(200, 40, 70)

    export const strokeStyle = (opacity: number = 0.75) => base.opacity(opacity).toString()
    export const fillStyle = () => base.brightness(15).toString()
    export const gridStyle = (opacity: number = 0.12) => grid.opacity(opacity).toString()

    export const baselineGradient = (context: CanvasRenderingContext2D,
                                     top: number, bottom: number, bipolar: boolean): CanvasGradient => {
        const gradient = context.createLinearGradient(0, top, 0, bottom)
        gradient.addColorStop(0.0, strokeStyle(0.2))
        if (bipolar) {gradient.addColorStop(0.5, strokeStyle(0.0))}
        gradient.addColorStop(1.0, strokeStyle(bipolar ? 0.2 : 0.0))
        return gradient
    }

    export const initialize = (root: { style: { setProperty: (name: string, value: string) => void } }) => {
        root.style.setProperty("--display-stroke", base.toString())
        root.style.setProperty("--display-fill", base.brightness(15).toString())
        root.style.setProperty("--display-grid", grid.toString())
    }
}
