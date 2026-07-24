import {CanvasPainter, LinearScale, LogScale, Scale} from "@opendaw/studio-core"

export const UNIT_COLOR = "rgba(255,255,255,0.3)"
export const UNIT_COLOR_DIM = "hsl(197, 10%, 55%)" // matches --color-shadow

export const clearBg = ({context, actualWidth, actualHeight}: CanvasPainter): void =>
    context.clearRect(0, 0, actualWidth, actualHeight)

export const unitLabel = (context: CanvasRenderingContext2D, text: string, x: number, y: number,
                          align: CanvasTextAlign, baseline: CanvasTextBaseline,
                          color: string = UNIT_COLOR): void => {
    context.fillStyle = color
    context.font = `${Math.round(8 * devicePixelRatio)}px sans-serif`
    context.textAlign = align
    context.textBaseline = baseline
    context.fillText(text, x, y)
}

export const SPEC_Y: Scale = new LinearScale(-96.0, 0.0)
export const SPEC_X_LOG: Scale = new LogScale(20.0, 20_000.0)
export const SPEC_X_LIN: Scale = new LinearScale(20.0, 20_000.0)
export const FREQ_TICKS: ReadonlyArray<readonly [number, string]> = [
    [20, "20"], [50, "50"], [100, "100"], [200, "200"], [500, "500"],
    [1_000, "1k"], [2_000, "2k"], [5_000, "5k"], [10_000, "10k"], [20_000, "20k"]
]
