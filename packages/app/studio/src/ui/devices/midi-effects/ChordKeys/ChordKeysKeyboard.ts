import {int} from "@opendaw/lib-std"
import {MidiKeys} from "@opendaw/lib-dsp"
import {Colors} from "@opendaw/studio-enums"

export namespace ChordKeysKeyboard {
    export type KeyRect = { readonly pitch: int, readonly x: number, readonly y: number, readonly w: number, readonly h: number }

    // draws the keys of `octaves` octaves from `low` and returns them topmost first for hit tests
    export const draw = (context: CanvasRenderingContext2D, width: number, height: number, low: int, octaves: int,
                         lit: (pitch: int) => boolean, label: (pitch: int) => string): ReadonlyArray<KeyRect> => {
        const whiteWidth = width / (octaves * 7)
        const whites: Array<KeyRect> = []
        const blacks: Array<KeyRect> = []
        let index = 0
        for (let pitch = low; pitch < low + octaves * 12; pitch++) {
            if (MidiKeys.isBlackKey(pitch)) {
                blacks.push({pitch, x: index * whiteWidth - whiteWidth * 0.3, y: 0, w: whiteWidth * 0.6, h: height * 0.6})
            } else {
                whites.push({pitch, x: index * whiteWidth, y: 0, w: whiteWidth, h: height})
                index++
            }
        }
        context.clearRect(0, 0, width, height)
        context.textAlign = "center"
        const paint = (black: boolean) => ({pitch, x, y, w, h}: KeyRect) => {
            context.fillStyle = lit(pitch) ? Colors.orange.toString() : black ? Colors.black.toString() : Colors.gray.toString()
            context.fillRect(x + 1, y, w - 2, h - 1)
            const text = label(pitch)
            if (text === "") {return}
            context.fillStyle = lit(pitch) || !black ? Colors.black.toString() : Colors.gray.toString()
            context.font = `${Math.round(h * (black ? 0.14 : 0.12))}px sans-serif`
            context.fillText(text, x + w / 2, y + h - h * 0.08)
        }
        whites.forEach(paint(false))
        blacks.forEach(paint(true))
        return [...blacks, ...whites]
    }
}
