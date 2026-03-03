import {int, linear, Nullable, Terminable, Terminator} from "@opendaw/lib-std"
import {gainToDb} from "@opendaw/lib-dsp"
import {NeuralAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {CanvasPainter} from "../../../../../../../studio/core/src/ui/canvas/painter.ts"
import {DisplayPaint} from "@/ui/devices/DisplayPaint"

export const createSpectrumRenderer = (canvas: HTMLCanvasElement,
                                       adapter: NeuralAmpDeviceBoxAdapter,
                                       receiver: LiveStreamReceiver,
                                       sampleRate: number): Terminable => {
    const terminator = new Terminator()
    let spectrum: Nullable<Float32Array> = null
    const painter = terminator.own(new CanvasPainter(canvas, painter => {
        if (spectrum === null) {return}
        const context = painter.context
        const width = painter.actualWidth
        const height = painter.actualHeight
        context.clearRect(0, 0, width, height)
        const numBins = spectrum.length
        const freqStep = sampleRate / (numBins << 1)
        const minFreq = 20
        const maxFreq = 20000
        const minDb = -60
        const maxDb = -3
        const freqToX = (freq: number): number => {
            const norm = Math.log(freq / minFreq) / Math.log(maxFreq / minFreq)
            return norm * width
        }
        const dbToY = (db: number): number => {
            const norm = (db - minDb) / (maxDb - minDb)
            return (1.0 - norm) * height
        }
        let x0: int = 0 | 0
        let lastEnergy = spectrum[0]
        let currentEnergy = lastEnergy
        let minY = height
        const path2D = new Path2D()
        const startY = dbToY(gainToDb(lastEnergy))
        minY = Math.min(minY, startY)
        path2D.moveTo(0, startY)
        for (let i = 1; i < numBins; ++i) {
            const energy = spectrum[i]
            if (currentEnergy < energy) {
                currentEnergy = energy
            }
            let x1 = freqToX(i * freqStep) | 0
            if (x1 > width) {
                i = numBins
                x1 = width
            }
            if (x0 < x1) {
                const xn = x1 - x0
                const scale = 1.0 / xn
                const y1 = dbToY(gainToDb(lastEnergy))
                const y2 = dbToY(gainToDb(currentEnergy))
                minY = Math.min(minY, y2)
                for (let x = 1; x <= xn; ++x) {
                    path2D.lineTo(x0 + x, linear(y1, y2, x * scale))
                }
                lastEnergy = currentEnergy
                currentEnergy = 0.0
            }
            x0 = x1
        }
        context.lineWidth = 1
        context.strokeStyle = DisplayPaint.strokeStyle(0.80)
        context.stroke(path2D)
        path2D.lineTo(width, height)
        path2D.lineTo(0, height)
        path2D.closePath()
        const gradient = context.createLinearGradient(0, minY, 0, height)
        gradient.addColorStop(0, DisplayPaint.strokeStyle(0.25))
        gradient.addColorStop(1, "transparent")
        context.fillStyle = gradient
        context.fill(path2D)
    }))
    terminator.own(receiver.subscribeFloats(adapter.spectrum, values => {
        spectrum = values
        painter.requestUpdate()
    }))
    return terminator
}