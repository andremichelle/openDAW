import css from "./ClipsHeader.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle, ObservableValue, Option, Terminator, UUID} from "@opendaw/lib-std"
import {createElement, DomElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {deferNextFrame, Dragging, Events, Html} from "@opendaw/lib-dom"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {ClipWidth, getClipColumnFit} from "@/ui/timeline/tracks/audio-unit/clips/constants"

const className = Html.adoptStyleSheet(css, "ClipsHeader")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

type Cell = {
    readonly terminator: Terminator
    readonly selector: HTMLElement
    readonly label: HTMLElement
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
    const rebuild = lifecycle.own(deferNextFrame(() => {
        const count = clips.count.getValue()
        for (let index = cells.length; index < count; index++) {
            const isPlaying = new DefaultObservableValue(false)
            const terminator = lifecycle.spawn()
            const playIcon: DomElement = <Icon symbol={IconSymbol.Play} className="icon-play"/>
            const stopIcon: DomElement = <Icon symbol={IconSymbol.Stop} className="icon-stop"/>
            const label: HTMLElement = <span/>
            const selector: HTMLElement = (
                <div className="selector">
                    {label}
                    {playIcon}
                    {stopIcon}
                </div>
            )
            element.appendChild(selector)
            terminator.ownAll(
                Events.subscribe(playIcon, "pointerdown", () => {
                    const clipsIds: Array<UUID.Bytes> = []
                    const column = clips.scroll.getValue() + index
                    rootBoxAdapter.audioUnits.adapters()
                        .forEach(unit => unit.tracks.values()
                            .forEach(track => track.clips.collection.getAdapterByIndex(column)
                                .ifSome(clip => clipsIds.push(clip.uuid)))) // muted clips launch too (silently)
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
            cells[index] = {terminator, selector, label, isPlaying}
        }
        if (count < cells.length) {
            cells
                .splice(count)
                .forEach(({terminator, selector}) => {
                    selector.remove()
                    terminator.terminate()
                })
        }
        const scroll = clips.scroll.getValue()
        cells.forEach(({label}, index) => label.textContent = String(scroll + index + 1))
    }))
    const {request: requestRebuild} = rebuild
    lifecycle.ownAll(
        clips.visible.catchupAndSubscribe(owner => {
            rebuild.cancel()
            runtime.terminate()
            if (owner.getValue()) {
                runtime.ownAll(
                    clips.count.catchupAndSubscribe(requestRebuild),
                    clips.scroll.subscribe(requestRebuild), {
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
            const timeline = element.parentElement
            const available = isDefined(timeline)
                ? timeline.getBoundingClientRect().right - element.getBoundingClientRect().left
                : Number.POSITIVE_INFINITY
            const fit = getClipColumnFit(available)
            return Option.wrap({
                update: ({clientX: newPosition}) => {
                    const newValue = Math.max(0, beginValue + Math.round((newPosition - beginPosition) / ClipWidth))
                    clips.setCount(newValue, fit)
                    clips.visible.setValue(newValue > 0)
                },
                cancel: () => {}
            } satisfies Dragging.Process)
        })
    )

    return element
}
