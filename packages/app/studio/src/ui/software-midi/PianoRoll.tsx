import css from "./PianoRoll.sass?inline"
import {Html} from "@opendaw/lib-dom"
import {createElement, Frag} from "@opendaw/lib-jsx"
import {PianoRollLayout} from "@/ui/PianoRollLayout"
import {NoteShortcuts} from "@/ui/shortcuts/SoftwareMIDIShortcuts"
import {Lifecycle} from "@opendaw/lib-std"

const className = Html.adoptStyleSheet(css, "PianoRoll")

type Construct = {
    lifecycle: Lifecycle
    pianoLayout: PianoRollLayout
}

export const PianoRoll = ({lifecycle, pianoLayout}: Construct): SVGElement => {
    const {sizes: {whiteKeys, blackKeys}} = pianoLayout
    const fontSize = "8px"
    return (
        <svg classList={className}
             viewBox={`0.5 0 ${pianoLayout.whiteKeys.length * whiteKeys.width - 1} ${(whiteKeys.height)}`}
             width="320px">
            {pianoLayout.whiteKeys.map(({key, x}) => {
                const noteShortcut = NoteShortcuts[key]
                return (
                    <Frag>
                        <rect classList="white" data-key={key} x={x + 0.5} y={0} rx={1} ry={1}
                              width={whiteKeys.width - 1} height={whiteKeys.height}/>
                        <text x={(x + whiteKeys.width / 2).toString()}
                              y={(whiteKeys.height - 6).toString()}
                              fill="black"
                              font-size={fontSize}
                              text-anchor="middle"
                              dominant-baseline="alphabetic"
                              onInit={element => lifecycle.own(noteShortcut.shortcut.subscribe(() =>
                                  element.textContent = noteShortcut.shortcut.format().join("")))}>
                            {noteShortcut.shortcut.format()}
                        </text>
                    </Frag>
                )
            })}
            {pianoLayout.blackKeys.map(({key, x}) => {
                const noteShortcut = NoteShortcuts[key]
                return (
                    <Frag>
                        <rect classList="black" data-key={key} x={x} y={-2} rx={1} ry={1}
                              width={blackKeys.width} height={blackKeys.height}/>
                        <text x={(x + blackKeys.width / 2).toString()}
                              y={(blackKeys.height - 6).toString()}
                              fill="white"
                              font-size={fontSize}
                              text-anchor="middle"
                              dominant-baseline="alphabetic"
                              onInit={element => lifecycle.own(noteShortcut.shortcut.subscribe(() =>
                                  element.textContent = noteShortcut.shortcut.format().join("")))}>
                            {noteShortcut.shortcut.format()}
                        </text>
                    </Frag>
                )
            })}
        </svg>
    )
}