export namespace DisplayPaint {
    export const strokeStyle = (opacity: number = 0.75) => `hsla(200, 83%, 60%, ${opacity})`

    export const baselineGradient = (context: CanvasRenderingContext2D,
                                     top: number, bottom: number, bipolar: boolean): CanvasGradient => {
        const gradient = context.createLinearGradient(0, top, 0, bottom)
        gradient.addColorStop(0.0, strokeStyle(0.2))
        if (bipolar) {gradient.addColorStop(0.5, strokeStyle(0.0))}
        gradient.addColorStop(1.0, strokeStyle(bipolar ? 0.2 : 0.0))
        return gradient
    }
}