import css from "./GroupClipLane.sass?inline"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {deferNextFrame, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {Icon} from "@/ui/components/Icon"
import {ClipLaneClassName} from "../TrackStyles"
import {GroupClipLauncher} from "./GroupClipLauncher"

const className = Html.adoptStyleSheet(css, "GroupClipLane")

type Construct = {lifecycle: Lifecycle, service: StudioService, unit: AudioUnitBox}

export const GroupClipLane = ({lifecycle, service, unit}: Construct): HTMLElement => {
    const element: HTMLElement = <div className={Html.buildClassList(ClipLaneClassName, className)}/>
    const runtime = lifecycle.own(new Terminator())
    const clips = service.timeline.clips
    const rebuild = () => {
        runtime.terminate()
        element.replaceChildren()
        if (!clips.visible.getValue()) {return}
        const launcher = runtime.own(new GroupClipLauncher(service.project, unit))
        const cells: Array<{element: HTMLButtonElement, preview: HTMLElement}> = []
        for (let index = 0; index < clips.columns.getValue(); index++) {
            const preview: HTMLElement = <span className="colors" aria-hidden="true"/>
            const cell: HTMLButtonElement = <button className="group-clip" type="button"
                aria-label={`Launch group scene ${index + 1}`} style={{gridColumn: `${index + 1} / ${index + 2}`}}
                onclick={() => launcher.toggle(index)}>
                <span className="label">Scene {index + 1}</span>
                <span className="content">
                    <Icon symbol={IconSymbol.Play} className="play"/>
                    <Icon symbol={IconSymbol.Stop} className="stop"/>
                    {preview}
                </span>
            </button>
            cells.push({element: cell, preview})
            element.appendChild(cell)
        }
        const update = () => cells.forEach(({element: cell, preview}, index) => {
            const contents = launcher.clips(index)
            const state = launcher.state(index)
            cell.disabled = contents.length === 0
            cell.classList.toggle("waiting", state === "waiting")
            cell.classList.toggle("playing", state === "playing")
            cell.setAttribute("aria-label", `${state === "idle" ? "Launch" : "Stop"} group scene ${index + 1}`)
            cell.setAttribute("aria-pressed", String(state !== "idle"))
            preview.replaceChildren(...contents.map(clip => <span style={{
                backgroundColor: `hsl(${clip.hue}, ${clip.mute || !clip.trackBoxAdapter.unwrap().enabled.getValue() ? 5 : 60}%, 60%)`
            }}/>))
        })
        const deferred = runtime.own(deferNextFrame(update))
        runtime.own(launcher.subscribe(deferred.request))
        update()
        element.scrollLeft = clips.scroll.getValue()
    }
    lifecycle.ownAll(
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
