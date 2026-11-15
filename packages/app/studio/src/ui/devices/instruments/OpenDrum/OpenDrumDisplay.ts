import {Colors} from "@opendaw/studio-enums"
import {OpenDrumSynth} from "@/ui/devices/instruments/OpenDrum/OpenDrumSynth"

/** Paints a hit's picture and a dot on its level curve per sounding hit (`positions` in seconds, -1 ends the list). */
export namespace OpenDrumDisplay {
    export const paint = (context: CanvasRenderingContext2D, width: number, height: number, pixelRatio: number,
                          picture: OpenDrumSynth.Picture, positions: Float32Array): void => {
        const middle = height / 2
        const columns = OpenDrumSynth.Columns
        const {length, span, peaks, envelope, pitch} = picture
        const lastColumn = length / (span * OpenDrumSynth.SampleRate) * columns
        context.fillStyle = Colors.shadow.opacity(0.2).toString()
        context.fillRect(0, Math.round(middle), width, pixelRatio)
        context.fillStyle = Colors.blue.opacity(0.6).toString()
        for (let x = 0; x < width; x++) {
            const from = Math.floor(x / width * columns)
            const to = Math.min(columns, Math.max(from + 1, Math.floor((x + 1) / width * columns)))
            if (from >= lastColumn) {break}
            let min = 0.0
            let max = 0.0
            for (let column = from; column < to; column++) {
                min = Math.min(min, peaks[column * 2])
                max = Math.max(max, peaks[column * 2 + 1])
            }
            const top = middle - Math.min(1.0, max) * (middle - pixelRatio)
            const bottom = middle - Math.max(-1.0, min) * (middle - pixelRatio)
            context.fillRect(x, top, 1, Math.max(pixelRatio, bottom - top))
        }
        const curve = (values: Float32Array, style: string, dash: ReadonlyArray<number>): void => {
            if (values.length === 0) {return}
            context.strokeStyle = style
            context.lineWidth = pixelRatio
            context.setLineDash(dash.map(value => value * pixelRatio))
            context.beginPath()
            for (let x = 0; x < width; x++) {
                const index = Math.min(Math.floor(x / width * values.length), values.length - 1)
                const y = middle - values[index] * (middle - pixelRatio)
                if (x === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
            }
            context.stroke()
        }
        curve(envelope, Colors.white.opacity(0.9).toString(), [])
        curve(pitch, Colors.blue.toString(), [3, 2])
        context.setLineDash([])
        context.fillStyle = Colors.white.toString()
        for (const seconds of positions) {
            if (seconds < 0.0) {break}
            const column = Math.floor(seconds / span * columns)
            if (column >= columns) {continue}
            const y = middle - envelope[column] * (middle - pixelRatio)
            context.beginPath()
            context.arc(column / columns * width, y, 2.5 * pixelRatio, 0, Math.PI * 2)
            context.fill()
        }
    }
}
