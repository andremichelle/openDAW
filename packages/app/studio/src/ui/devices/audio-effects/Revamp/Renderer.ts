import {CanvasUnitPainter} from "../../../../../../../studio/core/src/ui/canvas/painter.ts"
import {int, linear, Nullable, Terminable} from "@opendaw/lib-std"
import {RevampDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Scale} from "../../../../../../../studio/core/src/ui/canvas/scale.ts"
import {
    Bell,
    CurveRenderer,
    HighPass,
    HighShelf,
    LowPass,
    LowShelf
} from "@/ui/devices/audio-effects/Revamp/Curves.ts"
import {ColorSets, curveSampleRate} from "./constants.ts"
import {gainToDb} from "@opendaw/lib-dsp"

export const plotSpectrum = (context: CanvasRenderingContext2D,
                             xAxis: Scale,
                             yAxis: Scale,
                             spectrum: Float32Array,
                             sampleRate: number) => {
    const {canvas} = context
    const numBins = spectrum.length
    const freqStep = sampleRate / (numBins << 1)
    const width = canvas.width = canvas.clientWidth * devicePixelRatio
    const height = canvas.height = canvas.clientHeight * devicePixelRatio
    let x0: int = 0 | 0
    let lastEnergy = spectrum[0]
    let currentEnergy = lastEnergy
    const path2D = new Path2D()
    path2D.moveTo(0, (1.0 - yAxis.unitToNorm(gainToDb(lastEnergy))) * height)
    for (let i = 1; i < numBins; ++i) {
        const energy = spectrum[i]
        if (currentEnergy < energy) {
            currentEnergy = energy
        }
        let x1 = (xAxis.unitToNorm(i * freqStep) * width) | 0
        if (x1 > width) {
            i = numBins
            x1 = width
        }
        if (x0 < x1) {
            const xn = x1 - x0
            const scale = 1.0 / xn
            const y1 = yAxis.unitToNorm(gainToDb(lastEnergy))
            const y2 = yAxis.unitToNorm(gainToDb(currentEnergy))
            for (let x = 1; x <= xn; ++x) {
                path2D.lineTo(x0 + x, (1.0 - linear(y1, y2, x * scale)) * height)
            }
            lastEnergy = currentEnergy
            currentEnergy = 0.0
        }
        x0 = x1
    }
    context.lineWidth = 0.0
    context.fillStyle = "hsla(200, 83%, 60%, 0.04)"
    context.strokeStyle = "hsla(200, 83%, 60%, 0.80)"
    context.stroke(path2D)
    path2D.lineTo(width, height)
    path2D.lineTo(0, height)
    path2D.closePath()
    context.fill(path2D)
}

export const createCurveRenderer = (canvas: HTMLCanvasElement,
                                    xAxis: Scale,
                                    yAxis: Scale,
                                    adapter: RevampDeviceBoxAdapter): Terminable => {
    const {highPass, lowShelf, lowBell, midBell, highBell, highShelf, lowPass} = adapter.namedParameter
    const renderers: ReadonlyArray<CurveRenderer> = [
        new HighPass(highPass, ColorSets[0], curveSampleRate),
        new LowShelf(lowShelf, ColorSets[1], curveSampleRate),
        new Bell(lowBell, ColorSets[2], curveSampleRate),
        new Bell(midBell, ColorSets[3], curveSampleRate),
        new Bell(highBell, ColorSets[4], curveSampleRate),
        new HighShelf(highShelf, ColorSets[5], curveSampleRate),
        new LowPass(lowPass, ColorSets[6], curveSampleRate)
    ]
    let responseArrays: Nullable<[Float32Array, Float32Array, Float32Array]> = null
    const canvasPainter = new CanvasUnitPainter(canvas, xAxis, yAxis, painter => {
        if (responseArrays === null || responseArrays[0].length !== painter.actualWidth) {
            const n = Math.ceil(painter.actualWidth)
            responseArrays = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
            const frequencies = responseArrays[0]
            for (let i = 0; i < n; i++) {
                frequencies[i] = xAxis.normToUnit(i / (n - 1)) / curveSampleRate
            }
        }
        const context = painter.context
        context.lineWidth = 1
        context.globalCompositeOperation = "lighten"
        const [frequencies, phaseResponse, totalResponse] = responseArrays
        totalResponse.fill(0.0)
        if (painter.isResized) {
            renderers.forEach(renderer => renderer.onResize())
        }
        renderers.forEach(renderer => renderer.update(painter, frequencies, phaseResponse, totalResponse))
        context.strokeStyle = "rgba(255, 255, 255, 0.5)"
        const curve = new Path2D()
        for (let x = 0; x < totalResponse.length; x++) {
            const y = Math.round(painter.unitToY(totalResponse[x])) - 0.5
            if (x === 0) {curve.moveTo(x, y)} else {curve.lineTo(x, y)}
        }
        context.stroke(curve)
    })
    return Terminable.many(
        canvasPainter,
        ...renderers,
        ...renderers.map(renderer => renderer.subscribe(() => canvasPainter.requestUpdate())))
}