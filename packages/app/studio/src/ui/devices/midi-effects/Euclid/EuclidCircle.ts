import {int} from "@opendaw/lib-std"
import {Colors} from "@opendaw/studio-enums"
import {Fonts} from "@/ui/Fonts"
import {EuclidRhythm} from "./EuclidRhythm"

/** Paints a lane's steps on the outer ring, its accents on the middle ring and its bursts on the inner ring. */
export namespace EuclidCircle {
    export type Picture = {
        readonly steps: ReadonlyArray<EuclidRhythm.Step>
        readonly repeats: int
        readonly fade: number
        readonly playing: int
        readonly caption: string
        readonly rate: string
    }

    export const paint = (context: CanvasRenderingContext2D, width: number, height: number,
                          {steps, repeats, fade, playing, caption, rate}: Picture): void => {
        const size = Math.min(width, height)
        const centerX = width / 2
        const centerY = height / 2
        const outer = size * 0.42
        const count = Math.max(1, steps.length)
        const dot = Math.min(size * 0.035, Math.PI * outer / count * 0.42)
        const angleOf = (index: int): number => index / count * Math.PI * 2.0 - Math.PI * 0.5
        const at = (index: int, radius: number): [number, number] =>
            [centerX + Math.cos(angleOf(index)) * radius, centerY + Math.sin(angleOf(index)) * radius]
        const circle = (x: number, y: number, radius: number, fill: string): void => {
            context.beginPath()
            context.arc(x, y, radius, 0, Math.PI * 2.0)
            context.fillStyle = fill
            context.fill()
        }
        steps.forEach((step, index) => {
            const current = index === playing
            const [x, y] = at(index, outer)
            if (step.hit) {
                circle(x, y, dot * (current ? 1.35 : 1.0), (current ? Colors.bright : Colors.red).toString())
            } else {
                circle(x, y, dot * 0.55, (current ? Colors.bright : Colors.shadow.opacity(0.6)).toString())
            }
            if (!step.hit) {return}
            const [ax, ay] = at(index, outer * 0.74)
            circle(ax, ay, step.accent ? dot * 0.8 : dot * 0.25,
                step.accent ? Colors.orange.toString() : Colors.shadow.opacity(0.5).toString())
            if (!step.burst) {return}
            for (let repeat = 0; repeat < repeats; repeat++) {
                const [bx, by] = at(index, outer * (0.56 - repeat * 0.07))
                circle(bx, by, dot * 0.45, Colors.yellow.opacity(Math.max(0.1, 1.0 - Math.abs(fade) * (fade < 0.0 ? repeats - 1 - repeat : repeat) / (repeats - 1))).toString())
            }
        })
        context.textAlign = "center"
        context.textBaseline = "middle"
        context.fillStyle = Colors.cream.toString()
        context.font = `${Math.round(size * 0.09)}px ${Fonts.Rubik["font-family"]}, sans-serif`
        context.fillText(caption, centerX, centerY - size * 0.03)
        context.fillStyle = Colors.shadow.toString()
        context.font = `${Math.round(size * 0.06)}px ${Fonts.Rubik["font-family"]}, sans-serif`
        context.fillText(rate, centerX, centerY + size * 0.07)
    }
}
