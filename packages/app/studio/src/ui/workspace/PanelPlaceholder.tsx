import css from "./PanelPlaceholder.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle, Nullable, ObservableValue, Optional, Terminator} from "@moises-ai/lib-std"
import {Icon} from "@/ui/components/Icon.tsx"
import {appendChildren, createElement, DomElement, Frag, Group, replaceChildren} from "@moises-ai/lib-jsx"
import {PanelContents} from "@/ui/workspace/PanelContents.tsx"
import {Workspace} from "@/ui/workspace/Workspace.ts"
import {PanelState} from "@/ui/workspace/PanelState.ts"
import {AxisProperty} from "@/ui/workspace/AxisProperty.ts"
import {ContextMenu, MenuItem} from "@moises-ai/studio-core"
import {ContentGlue} from "@/ui/workspace/ContentGlue.ts"
import {IconSymbol} from "@moises-ai/studio-enums"
import {Browser, Events, Html} from "@moises-ai/lib-dom"
import {AwarenessUserState, RoomAwareness} from "@/service/RoomAwareness"
import FlexLayoutConstrains = Workspace.FlexLayoutConstrains

const className = Html.adoptStyleSheet(css, "PanelPlaceholder")

type Construct = {
    lifecycle: Lifecycle
    orientation: Workspace.Orientation
    siblings: ReadonlyArray<ContentGlue>
    panelContents: PanelContents
    panelState: PanelState
    roomAwareness: ObservableValue<Nullable<RoomAwareness>>
}

export const PanelPlaceholder =
    ({lifecycle, panelContents, orientation, siblings, panelState, roomAwareness}: Construct) => {
        const {icon, name, constrains, minimizable, popoutable} = panelState
        const HeaderSize = 18
        const container = <Group/>
        const element: DomElement = <div className={Html.buildClassList(className, orientation)}
                                         data-panel-type={name}/>
        const panelContent = panelContents.getByType(panelState.panelType)

        // It works, but it feels misplaced here, because we are updating the siblings as well.
        // The panel system is a weak spot. FIXME Panel-System
        const updateLayout = () => {
            const style = element.style
            const property = AxisProperty[orientation]

            // Update element style and css-class
            if ((panelState.isMinimized || panelContent.isPopout) && minimizable) {
                style.flexGrow = "0"
                style[property.maxStyle] = style[property.minStyle] = `${HeaderSize}px`
                element.classList.add("closed")
            } else {
                element.classList.remove("closed")
                if (constrains.type === "fixed") {
                    style.flexGrow = "0"
                    style[property.minStyle] = style[property.maxStyle] = `${constrains.fixedSize + HeaderSize}px`
                } else if (constrains.type === "flex") {
                    style.flexGrow = constrains.flex.toString()
                    style[property.minStyle] = `${constrains.minSize}px`
                    style[property.maxStyle] = `${constrains.maxSize ?? Number.MAX_SAFE_INTEGER}px`
                }
            }

            // Update siblings flexGrow
            const flexible: Array<{ constrains: FlexLayoutConstrains, style: CSSStyleDeclaration }> = []
            siblings.forEach(({content, element: {style}}) => {
                if (!panelContents.isClosed(content) && content.constrains.type === "flex") {
                    flexible.push({constrains: content.constrains, style})
                }
            })
            if (flexible.length === 1) {
                flexible[0].style.flexGrow = "1" // stretch element to occupy remaining space
            } else {
                flexible.forEach(({style, constrains}) => style.flexGrow = constrains.flex.toString())
            }
        }

        const popupLabel: Element = (
            <div className="popup-label">
				<span>
					{`${panelState.name} is currently in another window.`}
				</span>
            </div>
        )
        const popoutIcon = new DefaultObservableValue(IconSymbol.Embed)
        const minimizedIcon = new DefaultObservableValue(IconSymbol.Minimized)
        const handler = lifecycle.own(panelContent.bind(panelState, container, {
            onEmbed: () => {
                if (popupLabel.isConnected) {popupLabel.remove()}
                popoutIcon.setValue(IconSymbol.Embed)
                minimizedIcon.setValue(IconSymbol.Minimized)
                updateLayout()
            },
            onPopout: () => {
                if (!panelState.minimizable) {container.appendChild(popupLabel)}
                popoutIcon.setValue(IconSymbol.Popout)
                updateLayout()
            },
            onMinimized: () => {
                if (popupLabel.isConnected) {popupLabel.remove()}
                popoutIcon.setValue(IconSymbol.Embed)
                minimizedIcon.setValue(IconSymbol.Maximized)
                updateLayout()
            }
        }))
        const presenceDots: HTMLElement = <div className="presence-dots"/>
        const header: HTMLElement = (
            <header>
                <Icon symbol={icon}/> <span>{name}</span> {presenceDots}
            </header>
        )
        const roomLifecycle = lifecycle.own(new Terminator())
        lifecycle.own(roomAwareness.catchupAndSubscribe(owner => {
            roomLifecycle.terminate()
            const awareness: Nullable<RoomAwareness> = owner.getValue()
            if (isDefined(awareness)) {
                const render = () => {
                    const states = awareness.awareness.getStates()
                    const localId = awareness.clientID
                    const dots: Array<{ userName: string, color: string, self: boolean }> = []
                    states.forEach((state, clientId) => {
                        const user: Optional<AwarenessUserState> = state.user
                        if (isDefined(user) && user.panel === name) {
                            dots.push({userName: user.name, color: user.color, self: clientId === localId})
                        }
                    })
                    dots.sort((first, second) => first.self === second.self ? 0 : first.self ? -1 : 1)
                    replaceChildren(presenceDots, ...dots.map(dot => (
                        <span className="dot" style={{backgroundColor: dot.color}} title={dot.userName}/>
                    )))
                }
                const awarenessApi = awareness.awareness
                awarenessApi.on("change", render)
                roomLifecycle.own({terminate: () => awarenessApi.off("change", render)})
                render()
            } else {
                replaceChildren(presenceDots)
            }
        }))
        appendChildren(element, <Frag>{header}{container}</Frag>)
        lifecycle.own(Events.subscribe(header, "dblclick", () => handler.toggleMinimize()))
        lifecycle.own(ContextMenu.subscribe(header, collector => collector.addItems(
            MenuItem.default({
                label: "Popout into new browser window",
                checked: handler.isPopout(),
                hidden: !Browser.isWeb(),
                selectable: popoutable
            }).setTriggerProcedure(handler.togglePopout)
        )))
        return element
    }