import css from "./AutotuneTuner.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Address} from "@opendaw/lib-box"
import {LiveStreamReceiver} from "@opendaw/lib-fusion"
import {Html} from "@opendaw/lib-dom"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "AutotuneTuner")

const GREEN = Colors.green.toString()
const YELLOW = Colors.yellow.toString()
const RED = Colors.red.toString()
const GRAY = Colors.gray.toString()
const BRIGHT = Colors.bright.toString()

// A real-time tuner for the autotune device. It reads the live telemetry the device broadcasts —
// [detectedMidi, targetNote, voiced] — and shows the note you are singing plus a needle at that pitch's
// deviation (in cents) from the nearest note: how far off you are = what the autotune is correcting.
// Green when in tune, amber/red as the deviation grows. Idle (—) when no note is sounding.

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"]
const CENTRE = 60.0 // viewBox x of the in-tune centre
const HALF_WIDTH = 44.0 // needle travel each side of centre, mapping ±50 cents

const noteName = (midi: number): string => {
    const note = Math.round(midi)
    return NAMES[((note % 12) + 12) % 12] + (Math.floor(note / 12) - 1)
}

type Construct = {
    lifecycle: Lifecycle
    receiver: LiveStreamReceiver
    address: Address
}

export const AutotuneTuner = ({lifecycle, receiver, address}: Construct) => {
    const note: SVGTextElement = <text x={`${CENTRE}`} y="13" text-anchor="middle" className="note">—</text>
    const cents: SVGTextElement = <text x="116" y="13" text-anchor="end" className="cents"/>
    const needle: SVGLineElement = <line x1={`${CENTRE}`} y1="20" x2={`${CENTRE}`} y2="32" stroke-width="2.5" stroke-linecap="round"/>
    const element: HTMLDivElement = (
        <div className={className}>
            <svg viewBox="0 0 120 36" preserveAspectRatio="xMidYMid meet">
                <rect x={`${CENTRE - 10 / 50 * HALF_WIDTH}`} y="21" width={`${2 * 10 / 50 * HALF_WIDTH}`}
                      height="10" rx="1" fill={GREEN} opacity="0.14"/>
                <line x1="12" y1="26" x2="108" y2="26" className="scale"/>
                <line x1={`${CENTRE}`} y1="21" x2={`${CENTRE}`} y2="31" className="tick-centre"/>
                <line x1={`${CENTRE - HALF_WIDTH / 2}`} y1="23" x2={`${CENTRE - HALF_WIDTH / 2}`} y2="29" className="tick"/>
                <line x1={`${CENTRE + HALF_WIDTH / 2}`} y1="23" x2={`${CENTRE + HALF_WIDTH / 2}`} y2="29" className="tick"/>
                {note}
                {needle}
                {cents}
            </svg>
        </div>
    )
    const values = new Float32Array(3)
    lifecycle.own(receiver.subscribeFloats(address, incoming => {
        values.set(incoming)
        const detected = values[0], voiced = values[2] > 0.5
        if (!voiced || detected <= 0.0) {
            note.textContent = "—"
            note.setAttribute("fill", GRAY)
            cents.textContent = ""
            needle.setAttribute("x1", `${CENTRE}`)
            needle.setAttribute("x2", `${CENTRE}`)
            needle.setAttribute("stroke", GRAY)
            needle.setAttribute("opacity", "0.35")
            return
        }
        note.textContent = noteName(detected)
        note.setAttribute("fill", BRIGHT)
        const offset = (detected - Math.round(detected)) * 100.0 // cents from the nearest note, in [-50, 50]
        const x = CENTRE + offset / 50.0 * HALF_WIDTH
        const magnitude = Math.abs(offset)
        const color = magnitude < 10.0 ? GREEN : magnitude < 30.0 ? YELLOW : RED
        needle.setAttribute("x1", `${x}`)
        needle.setAttribute("x2", `${x}`)
        needle.setAttribute("stroke", color)
        needle.setAttribute("opacity", "1")
        cents.textContent = `${offset >= 0 ? "+" : ""}${Math.round(offset)}¢`
    }))
    return element
}
