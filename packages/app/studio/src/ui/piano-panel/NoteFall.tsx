import css from "./NoteFall.sass?inline"
import {Events, Html} from "@opendaw/lib-dom"
import {Arrays, int, isInstanceOf, Lifecycle, Notifier} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "../../../../../studio/core/src/ui/canvas/painter.ts"
import {PianoRollLayout} from "@/ui/PianoRollLayout.ts"
import {Fragmentor, LoopableRegion, MidiKeys, PPQN, ppqn} from "@opendaw/lib-dsp"
import {NoteRegionBoxAdapter} from "@opendaw/studio-adapters"
import {Fonts} from "@/ui/Fonts.ts"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "NoteFall")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    updateNotifier: Notifier<void>
}

type RenderCall = {
    pitch: int
    x: number
    y0: number
    y1: number
    hue: number
}

export const NoteFall = ({lifecycle, service, updateNotifier}: Construct) => {
    const {project} = service
    const {engine} = project
    const {position} = engine
    const pianoMode = project.rootBoxAdapter.pianoMode
    const {keyboard, timeRangeInQuarters, noteScale, noteLabels, transpose} = pianoMode
    const canvas: HTMLCanvasElement = <canvas/>
    const renderCalls: Array<RenderCall> = []
    const painter = new CanvasPainter(canvas, painter => {
        const {context, actualWidth, actualHeight} = painter
        const timeRange = PPQN.Quarter * timeRangeInQuarters.getValue()
        const labelEnabled = noteLabels.getValue()
        const min = position.getValue()
        const max = min + timeRange
        const positionToY = (position: ppqn) => (1.0 - (position - min) / timeRange) * actualHeight
        context.clearRect(0, 0, actualWidth, actualHeight)
        context.strokeStyle = "rgba(255, 255, 255, 0.2)"
        context.setLineDash([4, 4])
        context.beginPath()
        const pianoLayout = PianoRollLayout.getByIndex(keyboard.getValue())
        for (const position of pianoLayout.octaveSplits) {
            const x = Math.floor(position * actualWidth)
            context.moveTo(x, 0.0)
            context.lineTo(x, actualHeight)
        }
        const {nominator, denominator} = project.timelineBoxAdapter.box.signature
        const stepSize = PPQN.fromSignature(nominator.getValue(), denominator.getValue())
        for (const position of Fragmentor.iterate(min, max, stepSize)) {
            const y = Math.floor(positionToY(position))
            context.moveTo(0.0, y)
            context.lineTo(actualWidth, y)
        }
        context.stroke()
        context.setLineDash(Arrays.empty())
        context.textAlign = "center"
        context.textBaseline = "bottom"
        const noteWidth = actualWidth / pianoLayout.count * noteScale.getValue()
        context.font = `${noteWidth * devicePixelRatio * 0.55}px ${Fonts.Rubik["font-family"]}`
        renderCalls.length = 0
        project.rootBoxAdapter.audioUnits.adapters().forEach(audioUnitAdapter => {
            const trackBoxAdapters = audioUnitAdapter.tracks.values()
                .filter(adapter => !adapter.box.excludePianoMode.getValue())
            trackBoxAdapters.forEach(trackAdapter => {
                for (const region of trackAdapter.regions.collection.iterateRange(min, max)) {
                    if (!isInstanceOf(region, NoteRegionBoxAdapter)) {continue}
                    const hue = region.hue
                    const collection = region.optCollection.unwrap()
                    const events = collection.events
                    for (const {resultStart, resultEnd, rawStart} of LoopableRegion.locateLoops(region, min, max)) {
                        const searchStart = Math.floor(resultStart - rawStart)
                        const searchEnd = Math.floor(resultEnd - rawStart)
                        for (const note of events.iterateRange(searchStart - collection.maxDuration, searchEnd)) {
                            const pitch = note.pitch + transpose.getValue()
                            if (pitch < pianoLayout.min || pitch > pianoLayout.max) {continue}
                            renderCalls.push({
                                pitch,
                                x: pianoLayout.getCenteredX(pitch) * actualWidth,
                                // inverses the y-axis
                                y0: positionToY(note.complete + rawStart),
                                y1: positionToY(note.position + rawStart),
                                hue
                            })
                        }
                    }
                }
            })
        })
        // render shadow pass
        context.fillStyle = "rgba(0, 0, 0, 0.25)"
        context.beginPath()
        renderCalls.forEach(({x, y0, y1}) => {
            context.roundRect(x - noteWidth / 2, y0 + devicePixelRatio * 4, noteWidth, y1 - y0, 3 * devicePixelRatio)
        })
        context.fill()
        // render solid pass
        context.lineWidth = devicePixelRatio
        context.strokeStyle = "rgba(0, 0, 0, 0.5)"
        renderCalls.forEach(({x, y0, y1, hue}) => {
            const isPlaying = y1 >= actualHeight
            context.fillStyle = pianoLayout.getFillStyle(hue, isPlaying)
            context.beginPath()
            context.roundRect(x - noteWidth / 2, y0, noteWidth, y1 - y0, 3 * devicePixelRatio)
            context.fill()
            context.stroke()
            context.restore()
        })
        // render label pass
        if (labelEnabled) {
            renderCalls.forEach(({pitch, x, y0, y1}) => {
                context.save()
                context.beginPath()
                context.roundRect(x - noteWidth / 2, y0, noteWidth, y1 - y0, 3 * devicePixelRatio)
                context.clip()
                context.fillStyle = "rgba(0, 0, 0, 0.75)"
                MidiKeys.Names.English[pitch % 12]
                    .toUpperCase()
                    .split("")
                    .forEach((letter, index) => context
                        .fillText(letter, x, y1 - index * noteWidth * 0.45 * devicePixelRatio))
                context.restore()
            })
        }
    })
    const element: HTMLElement = (<div className={className}>{canvas}</div>)
    lifecycle.ownAll(
        painter,
        updateNotifier.subscribe(painter.requestUpdate),
        Html.watchResize(element, painter.requestUpdate),
        Events.subscribe(canvas, "wheel", event => {
            event.preventDefault()
            const ppqn = position.getValue() - Math.sign(event.deltaY) * PPQN.SemiQuaver * 2
            engine.setPosition(Math.max(0, ppqn))
        })
    )
    return element
}