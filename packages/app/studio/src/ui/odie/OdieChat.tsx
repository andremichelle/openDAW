import { createElement } from "@opendaw/lib-jsx"
import { Terminator } from "@opendaw/lib-std"
import { OdieService } from "./OdieService"
import { OdieInput } from "./OdieInput"
import { OdieMessageList } from "./OdieMessageList"

import { TIMEOUTS } from "./OdieConstants"

export const OdieChat = ({ service }: { service: OdieService }) => {

    // -- Components --
    const chatRoot = <div style={{
        position: "absolute", width: "100%", height: "100%",
        display: "flex", flexDirection: "column", background: "var(--color-panel-background)"
    } as any}>
        <div id="chat-content" style={{ flex: "1", display: "flex", flexDirection: "column", overflow: "hidden" } as any}>
            {/* Messages injected here */}
        </div>
    </div> as HTMLElement

    // Render loop for Chat
    const renderChat = () => {
        const contentContainer = chatRoot.querySelector("#chat-content") as HTMLElement
        if (!contentContainer) return
        while (contentContainer.firstChild) contentContainer.firstChild.remove()

        const messageList = OdieMessageList({ service })
        contentContainer.appendChild(messageList)

        // Propagate disconnect if exists on children
        const ml = messageList as unknown as {
            appendChild(el: HTMLElement): void,
            scrollTo(opt: { top: number, behavior: string }): void,
            cleanup?: () => void,
            onDisconnect?: () => void
        }
        if (ml.cleanup) {
            terminator.own({ terminate: () => ml.cleanup!() })
        } else if (ml.onDisconnect) {
            // Fallback for legacy components
            terminator.own({ terminate: () => ml.onDisconnect!() })
        }

        contentContainer.appendChild(OdieInput({ service }))

        // Auto scroll
        const list = contentContainer.firstElementChild as HTMLElement
        if (list) list.scrollTop = list.scrollHeight
    }

    const terminator = new Terminator()

    // Initial Render Only (OdieMessageList handles its own updates)
    setTimeout(() => renderChat(), TIMEOUTS.IMMEDIATE)

    const container = <div style={{
        position: "relative",
        width: "100%", height: "100%",
        overflow: "hidden"
    }}>
        {chatRoot}
    </div> as HTMLElement

        // Expose cleanup
        ; (container as unknown as { onDisconnect?: () => void }).onDisconnect = () => terminator.terminate()

    return container
}
