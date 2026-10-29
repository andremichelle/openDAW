import css from "./DevicePiano.sass?inline"
import {byte, int, isDefined, isInstanceOf, Lifecycle, Terminable} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {MidiData} from "@opendaw/lib-midi"
import {NoteStreamReceiver} from "@opendaw/studio-adapters"
import {MidiDevices} from "@opendaw/studio-core"
import {PianoRollLayout} from "@/ui/PianoRollLayout"

const className = Html.adoptStyleSheet(css, "DevicePiano")

const LowestPitch = 36
const NumKeys = 61

// plays the auditioned instrument through the software MIDI input, hardware keyboards reach it the same way
export const DevicePiano = ({lifecycle, notes}: { lifecycle: Lifecycle, notes: NoteStreamReceiver }): SVGElement => {
    const layout = new PianoRollLayout(0, NumKeys - 1, {whiteKeys: {width: 14, height: 40}, blackKeys: {width: 10, height: 24}})
    const {softwareMIDIInput} = MidiDevices
    const {sizes: {whiteKeys, blackKeys}} = layout
    const svg: SVGElement = (
        <svg classList={className} viewBox={`0 0 ${layout.whiteKeys.length * whiteKeys.width} ${whiteKeys.height}`}
             preserveAspectRatio="none">
            {layout.whiteKeys.map(({key, x}) => (
                <rect classList="white" data-key={key} x={x + 0.5} y={0} rx={1} ry={1}
                      width={whiteKeys.width - 1} height={whiteKeys.height}/>
            ))}
            {layout.blackKeys.map(({key, x}) => (
                <rect classList="black" data-key={key} x={x} y={-2} rx={1} ry={1}
                      width={blackKeys.width} height={blackKeys.height}/>
            ))}
        </svg>
    )
    const playing = {pitch: -1}
    const stop = (): void => {
        if (playing.pitch === -1) {return}
        softwareMIDIInput.sendNoteOff(playing.pitch)
        playing.pitch = -1
    }
    const play = (event: PointerEvent): void => {
        if (event.buttons === 0 || !isInstanceOf(event.target, SVGRectElement)) {return}
        const key = event.target.dataset.key
        if (!isDefined(key)) {return}
        const pitch = LowestPitch + parseInt(key)
        if (pitch === playing.pitch) {return}
        stop()
        softwareMIDIInput.sendNoteOn(pitch)
        playing.pitch = pitch
    }
    const update = (): void => {
        for (let key: int = 0; key < NumKeys; key++) {
            const pitch = LowestPitch + key
            svg.querySelector(`[data-key="${key}"]`)?.classList
                .toggle("active", softwareMIDIInput.hasActiveNote(pitch) || notes.isNoteOn(pitch))
        }
    }
    lifecycle.ownAll(
        Events.subscribe(svg, "pointerdown", event => {
            play(event)
            const subscription = Terminable.many(
                Events.subscribe(window, "pointermove", play, {capture: true}),
                Events.subscribe(window, "pointerup", () => {
                    subscription.terminate()
                    stop()
                }, {capture: true}))
        }),
        Events.subscribe(softwareMIDIInput, "midimessage", event =>
            MidiData.accept(event.data, {noteOn: (_note: byte, _velocity: byte) => update(), noteOff: (_note: byte) => update()})),
        notes.subscribe(update),
        Terminable.create(() => softwareMIDIInput.releaseAllNotes())
    )
    return svg
}
