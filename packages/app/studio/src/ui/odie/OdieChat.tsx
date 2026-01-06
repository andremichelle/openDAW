import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { OdieInput } from "./OdieInput"
import { OdieMessageList } from "./OdieMessageList"
import { OdieSettings } from "./OdieSettings"
import { Message } from "./services/llm/LLMProvider"
import { DefaultObservableValue } from "@opendaw/lib-std"

export const OdieChat = ({ service }: { service: OdieService }) => {
    // -- State --
    const messages = new DefaultObservableValue<Message[]>([])
    const isFlipped = new DefaultObservableValue<boolean>(false)

    // -- Chat View Logic --


    // -- Components --

    // 1. Settings Button (Floating)
    const settingsBtn = <button style={{
        position: "absolute", top: "16px", right: "16px", zIndex: "10",
        background: "transparent", border: "none", cursor: "pointer",
        fontSize: "18px", opacity: "0.5", color: "var(--color-text)"
    }}>⚙️</button> as HTMLButtonElement

    settingsBtn.onclick = () => isFlipped.setValue(true)

    // 2. Chat Face
    const chatFace = <div style={{
        position: "absolute", width: "100%", height: "100%",
        backfaceVisibility: "hidden",
        display: "flex", flexDirection: "column", background: "var(--color-panel-background)"
    } as any}>
        {settingsBtn}
        <div id="chat-content" style={{ flex: "1", display: "flex", flexDirection: "column", overflow: "hidden" } as any}>
            {/* Messages injected here */}
        </div>
    </div> as HTMLElement

    // Render loop for Chat
    const renderChat = (_msgs: Message[]) => {
        const contentContainer = chatFace.querySelector("#chat-content") as HTMLElement
        if (!contentContainer) return
        while (contentContainer.firstChild) contentContainer.firstChild.remove()

        contentContainer.appendChild(OdieMessageList({ service }))
        contentContainer.appendChild(OdieInput({ service }))

        // Auto scroll
        const list = contentContainer.firstElementChild as HTMLElement
        if (list) list.scrollTop = list.scrollHeight
    }
    messages.subscribe(owner => renderChat(owner.getValue()))
    setTimeout(() => renderChat(messages.getValue()), 0) // Defer initial render to ensure DOM

    // 3. Settings Face
    const settingsFace = <div style={{
        position: "absolute", width: "100%", height: "100%",
        backfaceVisibility: "hidden",
        transform: "rotateY(180deg)", background: "var(--color-panel-background)"
    } as any}></div> as HTMLElement

    // Mount Settings
    settingsFace.appendChild(OdieSettings({
        service,
        onBack: () => isFlipped.setValue(false)
    }))

    // -- Main Container (Flipper) --
    const flipper = <div style={{
        position: "relative", width: "100%", height: "100%",
        transition: "transform 0.6s",
        transformStyle: "preserve-3d",
        background: "transparent"
    }}>
        {chatFace}
        {settingsFace}
    </div> as HTMLElement

    const container = <div style={{
        perspective: "1000px",
        width: "100%", height: "100%",
        overflow: "hidden"
    }}>
        {flipper}
    </div> as HTMLElement

    // Subscribe to Flip
    isFlipped.subscribe(val => {
        flipper.style.transform = val.getValue() ? "rotateY(180deg)" : "rotateY(0deg)"
    })

    return container
}
