import {Color} from "@opendaw/lib-std"
import {Colors} from "@opendaw/studio-enums"
import {OpenDrumSynth} from "@/ui/devices/instruments/OpenDrum/OpenDrumSynth"

/** Paints a hit's picture: the waveform from its min and max columns, the level and the pitch curves. */
export namespace OpenDrumDisplay {
    export const paint = (context: CanvasRenderingContext2D, width: number, height: number, pixelRatio: number,
                          picture: OpenDrumSynth.Picture, color: Color): void => {
        const middle = height / 2
        const columns = OpenDrumSynth.Columns
        const {length, peaks, envelope, pitch, softPitch} = picture
        const lastColumn = length / (OpenDrumSynth.MaxSeconds * OpenDrumSynth.SampleRate) * columns
        context.fillStyle = Colors.shadow.opacity(0.2).toString()
        context.fillRect(0, Math.round(middle), width, pixelRatio)
        context.fillStyle = color.opacity(0.5).toString()
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
        curve(envelope, color.opacity(0.9).toString(), [])
        curve(softPitch, Colors.cream.opacity(0.35).toString(), [2, 2])
        curve(pitch, Colors.cream.opacity(0.9).toString(), [])
        context.setLineDash([])
    }
}
