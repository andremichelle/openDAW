import css from "./GroupClipLane.sass?inline"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {deferNextFrame, Html, Keyboard} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {Icon} from "@/ui/components/Icon"
import {ClipLaneClassName} from "../TrackStyles"
import {GroupClipAppearance} from "./GroupClipAppearance"
import {installGroupClipContextMenu} from "./GroupClipContextMenu"
import {GroupClipLauncher} from "./GroupClipLauncher"
import type {GroupClipSelection} from "./GroupClipSelection"

const className = Html.adoptStyleSheet(css, "GroupClipLane")

type Construct = {lifecycle: Lifecycle, service: StudioService, unit: AudioUnitBox, selection: GroupClipSelection}

export const GroupClipLane = ({lifecycle, service, unit, selection}: Construct): HTMLElement => {
    const element: HTMLElement = <div className={Html.buildClassList(ClipLaneClassName, className)}/>
    const runtime = lifecycle.own(new Terminator())
    const clips = service.timeline.clips
    const rebuild = () => {
        runtime.terminate()
        element.replaceChildren()
        if (!clips.visible.getValue()) {return}
        const launcher = runtime.own(new GroupClipLauncher(service.project, unit))
        const cells: Array<{element: HTMLElement, play: HTMLButtonElement, preview: HTMLElement, label: HTMLButtonElement}> = []
        for (let index = 0; index < clips.columns.getValue(); index++) {
            const label: HTMLButtonElement = <button className="label" type="button"
                onclick={() => selection.select(unit, index)}/>
            const preview: HTMLElement = <span className="colors" aria-hidden="true"/>
            const play: HTMLButtonElement = <button className="content" type="button" onclick={() => {
                selection.select(unit, index)
                launcher.toggle(index)
            }}>
                <Icon symbol={IconSymbol.Play} className="play"/>
                <Icon symbol={IconSymbol.Stop} className="stop"/>
                {preview}
            </button>
            const cell: HTMLElement = <div className="group-clip" style={{gridColumn: `${index + 1} / ${index + 2}`}}
                onkeydown={event => {
                    if (Keyboard.isDeselectAll(event)) {
                        selection.clear()
                    } else if (Keyboard.isDelete(event) && selection.isSelected(unit, index)) {
                        launcher.delete(index)
                        selection.clear()
                    } else {return}
                    event.preventDefault()
                    event.stopPropagation()
                }}>
                {label}
                {play}
            </div>
            runtime.own(installGroupClipContextMenu(cell, launcher, index))
            cells.push({element: cell, play, preview, label})
            element.appendChild(cell)
        }
        const update = () => cells.forEach(({element: cell, play, preview, label}, index) => {
            const contents = launcher.clips(index)
            const state = launcher.state(index)
            const appearance = GroupClipAppearance.read(unit, index)
            label.textContent = appearance.label
            cell.classList.toggle("named", appearance.label !== "")
            cell.classList.toggle("empty", contents.length === 0)
            cell.classList.toggle("muted", launcher.isMuted(index))
            cell.classList.toggle("waiting", state === "waiting")
            cell.classList.toggle("playing", state === "playing")
            label.setAttribute("aria-label", `Select group scene ${index + 1}${appearance.label === "" ? "" : `: ${appearance.label}`}`)
            label.setAttribute("aria-pressed", String(selection.isSelected(unit, index)))
            cell.classList.toggle("selected", selection.isSelected(unit, index))
            play.setAttribute("aria-label", `${state === "idle" ? "Launch" : "Stop"} group scene ${index + 1}${appearance.label === "" ? "" : `: ${appearance.label}`}`)
            play.setAttribute("aria-pressed", String(state !== "idle"))
            preview.replaceChildren(...contents.map(clip => <span style={{
                backgroundColor: `hsl(${clip.hue}, ${clip.mute || !clip.trackBoxAdapter.unwrap().enabled.getValue() ? 5 : 60}%, 60%)`
            }}/>))
        })
        const deferred = runtime.own(deferNextFrame(update))
        runtime.ownAll(launcher.subscribe(deferred.request), selection.value.subscribe(deferred.request))
        cells.forEach((_, index) => runtime.own(GroupClipAppearance.subscribe(unit, index, deferred.request)))
        update()
        element.scrollLeft = clips.scroll.getValue()
    }
    lifecycle.ownAll(
        unit.groupCollapsed.catchupAndSubscribe(field => element.classList.toggle("collapsed", field.getValue())),
        clips.columns.subscribe(() => {
            element.style.setProperty("--clip-columns", String(clips.columns.getValue()))
            rebuild()
        }),
        clips.visible.catchupAndSubscribe(rebuild),
        clips.scroll.catchupAndSubscribe(owner => element.scrollLeft = owner.getValue())
    )
    element.style.setProperty("--clip-columns", String(clips.columns.getValue()))
    return element
}
