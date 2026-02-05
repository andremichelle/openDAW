import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { OdieInput } from "./OdieInput"
import { OdieMessageList } from "./OdieMessageList"
import { Message } from "./services/llm/LLMProvider"
import { DefaultObservableValue } from "@opendaw/lib-std"
import { TIMEOUTS } from "./OdieConstants"

export const OdieChat = ({ service }: { service: OdieService }) => {
    // -- State --
    const messages = new DefaultObservableValue<Message[]>([])

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
    const renderChat = (_msgs: Message[]) => {
        const contentContainer = chatRoot.querySelector("#chat-content") as HTMLElement
        if (!contentContainer) return
        while (contentContainer.firstChild) contentContainer.firstChild.remove()

        contentContainer.appendChild(OdieMessageList({ service }))
        contentContainer.appendChild(OdieInput({ service }))

        // Auto scroll
        const list = contentContainer.firstElementChild as HTMLElement
        if (list) list.scrollTop = list.scrollHeight
    }
    messages.subscribe(owner => renderChat(owner.getValue()))
    setTimeout(() => renderChat(messages.getValue()), TIMEOUTS.IMMEDIATE) // Defer initial render to ensure DOM

    const container = <div style={{
        position: "relative",
        width: "100%", height: "100%",
        overflow: "hidden"
    }}>
        {chatRoot}
    </div> as HTMLElement

    return container
}
