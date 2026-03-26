import css from "./ChatOverlay.sass?inline"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Icon} from "@/ui/components/Icon.tsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {Lifecycle} from "@opendaw/lib-std"
import {ChatOverlayBackground} from "@/ui/ChatOverlayBackground.tsx"

const className = Html.adoptStyleSheet(css, "ChatOverlay")

type Construct = { lifecycle: Lifecycle }

export const ChatOverlay = ({lifecycle}: Construct) => {
    const element: HTMLElement = (
        <div className={className}>
            <div className="chat-tab" onInit={(tab: HTMLElement) => {
                lifecycle.own(Events.subscribe(tab, "click", () => {
                    element.classList.toggle("open")
                }))
            }}>
                <Icon symbol={IconSymbol.ChatEmpty}/>
            </div>
            <div className="chat-window"/>
        </div>
    )
    element.prepend(<ChatOverlayBackground lifecycle={lifecycle} element={element}/>)
    return element
}
