import css from "./PianoRoll.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {createElement, Group} from "@moises-ai/lib-jsx"
import {PianoRollLayout} from "@/ui/PianoRollLayout.ts"
import {isDefined, isInstanceOf, Lifecycle, Notifier} from "@moises-ai/lib-std"
import {LoopableRegion, ppqn} from "@moises-ai/lib-dsp"
import {NoteRegionBoxAdapter} from "@moises-ai/studio-adapters"
import {StudioService} from "@/service/StudioService"

const className = Html.adoptStyleSheet(css, "PianoRoll")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    updateNotifier: Notifier<void>
}

export const PianoRoll = ({lifecycle, service, updateNotifier}: Construct) => {
    const {project} = service
    const {engine, rootBoxAdapter: {pianoMode: {keyboard, transpose}}} = project
    const position = engine.position
    const getPianoLayout = () => PianoRollLayout.Defaults()[keyboard.getValue()]
    const createSVG = (): SVGSVGElement => {
        const pianoLayout = getPianoLayout()
        const {sizes: {whiteKeys, blackKeys}} = pianoLayout
        return (
            <svg classList={className}
                 viewBox={`0.5 0 ${pianoLayout.whiteKeys.length * whiteKeys.width - 1} ${(whiteKeys.height)}`}
                 width="100%">
                {pianoLayout.whiteKeys.map(({key, x}) => (
                    <rect classList="white" data-key={key} x={x + 0.5} y={0}
                          width={whiteKeys.width - 1} height={whiteKeys.height}/>
                ))}
                {pianoLayout.blackKeys.map(({key, x}) => (
                    <rect classList="black" data-key={key} x={x} y={2}
                          width={blackKeys.width} height={blackKeys.height} rx={4} ry={4}/>
                ))}
            </svg>
        )
    }
    let svg: SVGSVGElement = createSVG()
    const update = (position: ppqn) => {
        svg.querySelectorAll<SVGRectElement>("rect.playing")
            .forEach(rect => {
                rect.style.removeProperty("fill")
                rect.classList.remove("playing")
            })
        const pianoLayout = getPianoLayout()
        project.rootBoxAdapter.audioUnits.adapters().forEach(audioUnitAdapter => {
            const trackBoxAdapters = audioUnitAdapter.tracks.values()
                .filter(adapter => !adapter.box.excludePianoMode.getValue())
            trackBoxAdapters
                .forEach(trackAdapter => {
                    const region = trackAdapter.regions.collection.lowerEqual(position)
                    if (region === null || !isInstanceOf(region, NoteRegionBoxAdapter) || position >= region.complete) {
                        return
                    }
                    const collection = region.optCollection.unwrap()
                    const events = collection.events
                    const loopIterator = LoopableRegion.locateLoops(region, position, position)
                    for (const {resultStart, resultEnd, rawStart} of loopIterator) {
                        const searchStart = Math.floor(resultStart - rawStart)
                        const searchEnd = Math.floor(resultEnd - rawStart)
                        for (const note of events.iterateRange(searchStart - collection.maxDuration, searchEnd)) {
                            if (note.position + rawStart <= position && position < note.complete + rawStart) {
                                const pitch = note.pitch + transpose.getValue()
                                if (pitch < pianoLayout.min || pitch > pianoLayout.max) {continue}
                                const rect = svg.querySelector<SVGRectElement>(`[data-key="${pitch}"]`)
                                if (isDefined(rect)) {
                                    rect.style.fill = pianoLayout.getFillStyle(region.hue, true)
                                    rect.classList.add("playing")
                                }
                            }
                        }
                    }
                })
        })
    }
    const placeholder: Element = <Group>{svg}</Group>
    lifecycle.ownAll(
        keyboard.subscribe(() => {
            svg.remove()
            svg = createSVG()
            placeholder.appendChild(svg)
        }),
        updateNotifier.subscribe(() => update(position.getValue()))
    )
    update(position.getValue())
    return placeholder
}