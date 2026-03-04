import css from "./WorkspacePage.sass?inline"
import {Terminator} from "@opendaw/lib-std"
import {createElement, PageContext, PageFactory, replaceChildren} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {WorkspaceBuilder} from "@/ui/workspace/WorkspaceBuilder"
import {CursorOverlay} from "@/ui/collab/CursorOverlay"
import {CollabState} from "@opendaw/studio-core"

const className = Html.adoptStyleSheet(css, "WorkspacePage")

const CURSOR_THROTTLE_MS = 100

export const WorkspacePage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const main: HTMLElement = <main/>
    const cursorContainer: HTMLDivElement = <div/>
    const screenLifeTime = lifecycle.own(new Terminator())
    lifecycle.own(service.layout.screen.catchupAndSubscribe(owner => {
        screenLifeTime.terminate()
        WorkspaceBuilder.buildScreen(screenLifeTime, service.panelLayout, main, owner.getValue())
    }))
    const updateCursors = () => {
        replaceChildren(cursorContainer, CursorOverlay({
            participants: service.collabService.presence.participants
        }))
    }
    updateCursors()
    lifecycle.own(service.collabService.presence.onChange.subscribe(updateCursors))
    let lastCursorSend = 0
    const wrapper: HTMLDivElement = <div className={className} style={{position: "relative"}}>{main}{cursorContainer}</div>
    wrapper.addEventListener("mousemove", (event: MouseEvent) => {
        if (service.collabService.state !== CollabState.Connected) {return}
        const now = performance.now()
        if (now - lastCursorSend < CURSOR_THROTTLE_MS) {return}
        lastCursorSend = now
        const rect = wrapper.getBoundingClientRect()
        const cursorX = event.clientX - rect.left
        const cursorY = event.clientY - rect.top
        const target = event.target instanceof HTMLElement ? (event.target.dataset.trackId ?? "") : ""
        service.collabService.updateCursor(cursorX, cursorY, target)
    })
    return wrapper
}
