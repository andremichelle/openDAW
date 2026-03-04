import css from "./WorkspacePage.sass?inline"
import {Terminator} from "@opendaw/lib-std"
import {createElement, PageContext, PageFactory, replaceChildren} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"
import {WorkspaceBuilder} from "@/ui/workspace/WorkspaceBuilder"
import {CursorOverlay} from "@/ui/collab/CursorOverlay"

const className = Html.adoptStyleSheet(css, "WorkspacePage")

export const WorkspacePage: PageFactory<StudioService> = ({lifecycle, service}: PageContext<StudioService>) => {
    const main: HTMLElement = <main/>
    const cursorContainer: HTMLDivElement = <div/>
    const screenLifeTime = lifecycle.own(new Terminator())
    lifecycle.own(service.layout.screen.catchupAndSubscribe(owner => {
        screenLifeTime.terminate()
        WorkspaceBuilder.buildScreen(screenLifeTime, service.panelLayout, main, owner.getValue())
    }))
    lifecycle.own(service.collabService.presence.onChange.subscribe(() => {
        replaceChildren(cursorContainer, CursorOverlay({
            participants: service.collabService.presence.participants
        }))
    }))
    return <div className={className} style={{position: "relative"}}>{main}{cursorContainer}</div>
}