import css from "./ClipsHeader.sass?inline"
import {DefaultObservableValue, Lifecycle, ObservableValue, Option, Terminator, UUID} from "@moises-ai/lib-std"
import {createElement, DomElement} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {IconSymbol} from "@moises-ai/studio-enums"
import {deferNextFrame, Dragging, Events, Html} from "@moises-ai/lib-dom"
import {TextTooltip} from "@/ui/surface/TextTooltip"

const className = Html.adoptStyleSheet(css, "ClipsHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

type Cell = {
    readonly terminator: Terminator
    readonly selector: HTMLElement
    readonly isPlaying: ObservableValue<boolean>
}

export const ClipsHeader = ({lifecycle, service}: Construct) => {
    const resizer: HTMLElement = <div className="resizer"/>
    const element: HTMLElement = (<div className={className}>{resizer}</div>)
    const runtime = lifecycle.own(new Terminator())
    const {project, timeline} = service
    const {engine, rootBoxAdapter} = project
    const clips = timeline.clips
    const cells: Array<Cell> = []
    const {request: requestRebuild} = deferNextFrame(() => {
        const count = clips.count.getValue()
        for (let index = cells.length; index < count; index++) {
            const isPlaying = new DefaultObservableValue(false)
            const terminator = lifecycle.spawn()
            const playIcon: DomElement = <Icon symbol={IconSymbol.Play} className="icon-play"/>
            const stopIcon: DomElement = <Icon symbol={IconSymbol.Stop} className="icon-stop"/>
            const selector: HTMLElement = (
                <div className="selector">
                    <span>{index + 1}</span>
                    {playIcon}
                    {stopIcon}
                </div>
            )
            element.appendChild(selector)
            terminator.ownAll(
                Events.subscribe(playIcon, "pointerdown", () => {
                    const clipsIds: Array<UUID.Bytes> = []
                    rootBoxAdapter.audioUnits.adapters()
                        .forEach(unit => unit.tracks.values()
                            .forEach(track => track.clips.collection.getAdapterByIndex(index)
                                .ifSome(clip => {if (!clip.mute) {clipsIds.push(clip.uuid)}})))
                    engine.scheduleClipPlay(clipsIds)
                }),
                Events.subscribe(stopIcon, "pointerdown", () => {
                    const trackIds: Array<UUID.Bytes> = []
                    rootBoxAdapter.audioUnits.adapters()
                        .forEach(unit => unit.tracks.values()
                            .forEach(track => trackIds.push(track.uuid)))
                    engine.scheduleClipStop(trackIds)
                }),
                TextTooltip.default(playIcon, () => "Schedule column to play"),
                TextTooltip.default(stopIcon, () => "Schedule column to stop")
            )
            cells[index] = {terminator, selector, isPlaying}
        }
        if (count < cells.length) {
            cells
                .splice(count)
                .forEach(({terminator, selector}) => {
                    selector.remove()
                    terminator.terminate()
                })
        }
    })
    lifecycle.ownAll(
        clips.visible.catchupAndSubscribe(owner => {
            runtime.terminate()
            if (owner.getValue()) {
                runtime.ownAll(
                    clips.count.catchupAndSubscribe(requestRebuild), {
                        terminate: () => {
                            while (cells.length > 0) {
                                const {terminator, selector} = cells.pop()!
                                selector.remove()
                                terminator.terminate()
                            }
                        }
                    }
                )
                requestRebuild()
            }
        }),
        Dragging.attach(resizer, ({clientX: beginPosition}) => {
            const beginValue = clips.count.getValue()
            const cellSize = parseInt(window.getComputedStyle(element).getPropertyValue("--clips-width")) + 1 // gaps
            return Option.wrap({
                update: ({clientX: newPosition}) => {
                    const newValue = Math.max(0, beginValue + Math.round((newPosition - beginPosition) / cellSize))
                    clips.count.setValue(Math.max(1, newValue))
                    clips.visible.setValue(newValue > 0)
                },
                cancel: () => {}
            } satisfies Dragging.Process)
        })
    )

    return element
}