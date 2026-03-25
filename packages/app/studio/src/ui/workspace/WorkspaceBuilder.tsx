import {Workspace} from "@/ui/workspace/Workspace.ts"
import {PanelPlaceholder} from "@/ui/workspace/PanelPlaceholder.tsx"
import {PanelResizer} from "@/ui/workspace/PanelResizer.tsx"
import {PanelContents} from "@/ui/workspace/PanelContents.tsx"
import {ContentGlue} from "@/ui/workspace/ContentGlue.ts"
import {isDefined, Iterables, Lifecycle, Nullable, ObservableValue, Unhandled} from "@opendaw/lib-std"
import {RoomAwareness} from "@/service/RoomAwareness"
import {Html} from "@opendaw/lib-dom"
import {appendChildren, createElement} from "@opendaw/lib-jsx"

export namespace WorkspaceBuilder {
    export const buildScreen = (lifecycle: Lifecycle,
                                panelContents: PanelContents,
                                element: HTMLElement,
                                screenKey: Nullable<Workspace.ScreenKeys>,
                                roomAwareness: ObservableValue<Nullable<RoomAwareness>>) => {
        Html.empty(element)
        if (screenKey === null) {return}
        const build = (container: HTMLElement,
                       siblings: ContentGlue[],
                       content: Workspace.Content,
                       next: Nullable<Workspace.Content>,
                       orientation: Workspace.Orientation) => {
            const element: HTMLElement = (() => {
                if (content.type === "panel") {
                    return (
                        <PanelPlaceholder lifecycle={lifecycle}
                                          orientation={orientation}
                                          siblings={siblings}
                                          panelContents={panelContents}
                                          panelState={content}
                                          roomAwareness={roomAwareness}/>
                    )
                } else if (content.type === "layout") {
                    const section = (
                        <section className={Html.buildClassList("workspace", content.orientation)}>
                            <div className="fill"/>
                        </section>
                    )
                    const children: Array<ContentGlue> = []
                    for (const [curr, next] of Iterables.pairWise(content.contents)) {
                        build(section, children, curr, next, content.orientation)
                    }
                    return section
                } else {
                    return Unhandled(content)
                }
            })()
            siblings.push({element, content})
            appendChildren(container, element)
            if (content.constrains.type === "flex" && isDefined(next) && next.constrains.type === "flex") {
                container.appendChild(
                    <PanelResizer lifecycle={lifecycle}
                                  panelContents={panelContents}
                                  target={element}
                                  orientation={orientation}
                                  siblings={siblings}/>
                )
            }
        }
        build(element, [], Workspace.Default[screenKey].content, null, "vertical")
    }
}