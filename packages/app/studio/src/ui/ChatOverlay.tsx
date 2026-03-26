import css from "./ChatOverlay.sass?inline"
import {createElement, appendChildren} from "@opendaw/lib-jsx"
import {DefaultObservableValue, Lifecycle, Option, Terminator} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"
import {IconCartridge} from "@/ui/components/Icon.tsx"
import {Checkbox} from "@/ui/components/Checkbox.tsx"
import {Button} from "@/ui/components/Button.tsx"
import {Icon} from "@/ui/components/Icon.tsx"
import {IconSymbol} from "@opendaw/studio-enums"
import {ChatOverlayBackground} from "@/ui/ChatOverlayBackground.tsx"
import {StudioService} from "@/service/StudioService"
import {ChatService} from "@/chat/ChatService"
import {ChatMessage} from "@/chat/ChatMessage"

const className = Html.adoptStyleSheet(css, "ChatOverlay")

const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`
}

const renderMessage = (message: ChatMessage): HTMLElement => (
    <div className="message">
        <div className="header">
            <span className="dot" style={{backgroundColor: message.color}}/>
            <span className="name">{message.name}</span>
            <span className="time">{formatTime(message.timestamp)}</span>
        </div>
        <div className="text" style={{borderLeftColor: message.color}}>{message.text}</div>
    </div>
)

type Construct = { lifecycle: Lifecycle, service: StudioService }

export const ChatOverlay = ({lifecycle, service}: Construct) => {
    const sendOnEnter = lifecycle.own(new DefaultObservableValue<boolean>(true))
    const closeAfterSend = lifecycle.own(new DefaultObservableValue<boolean>(false))
    const tabIcon = lifecycle.own(new DefaultObservableValue<IconSymbol>(IconSymbol.ChatEmpty))
    const messagesContainer: HTMLElement = (<div className="messages"/>)
    const textArea: HTMLTextAreaElement = (<textarea placeholder="Type a message..." maxLength={300} rows={2}/>)
    const isOpen = () => element.classList.contains("open")
    const updateTabIcon = () => {
        tabIcon.setValue(hasUnread ? IconSymbol.ChatMessage : IconSymbol.ChatEmpty)
    }
    let hasUnread = false
    const markUnread = () => {
        if (!isOpen()) {
            hasUnread = true
            updateTabIcon()
        }
    }
    const clearUnread = () => {
        hasUnread = false
        updateTabIcon()
    }
    const element: HTMLElement = (
        <div className={className}>
            <div className="chat-tab" onInit={(tab: HTMLElement) => {
                lifecycle.own(Events.subscribe(tab, "click", () => {
                    const opening = !isOpen()
                    element.classList.toggle("open")
                    if (opening) {
                        clearUnread()
                    }
                }))
            }}>
                <IconCartridge lifecycle={lifecycle} symbol={tabIcon}/>
            </div>
            <div className="chat-window">
                {messagesContainer}
                <div className="input-area">
                    {textArea}
                    <Button lifecycle={lifecycle}
                            appearance={{framed: true, landscape: true}}
                            onClick={() => send()}>
                        <Icon symbol={IconSymbol.Play}/>
                    </Button>
                </div>
                <div className="options">
                    <Checkbox lifecycle={lifecycle} model={sendOnEnter}>
                        <Icon symbol={IconSymbol.Checkbox}/> Send on Enter
                    </Checkbox>
                    <Checkbox lifecycle={lifecycle} model={closeAfterSend}>
                        <Icon symbol={IconSymbol.Checkbox}/> Close after send
                    </Checkbox>
                </div>
            </div>
        </div>
    )
    element.prepend(<ChatOverlayBackground lifecycle={lifecycle} element={element}/>)
    const send = () => {
        service.chatService.ifSome(chatService => {
            chatService.sendMessage(textArea.value)
            textArea.value = ""
            if (closeAfterSend.getValue()) {
                setTimeout(() => element.classList.remove("open"), 1000)
            }
        })
    }
    lifecycle.own(Events.subscribe(textArea, "keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" && !event.shiftKey && sendOnEnter.getValue()) {
            event.preventDefault()
            send()
        }
    }))
    const scrollToBottom = () => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
    const serviceLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(service.chatService.catchupAndSubscribe((option: Option<ChatService>) => {
        serviceLifecycle.terminate()
        Html.empty(messagesContainer)
        hasUnread = false
        if (option.nonEmpty()) {
            const chatService = option.unwrap()
            element.classList.remove("hidden")
            const messages = chatService.messages()
            messages.forEach(message => {
                appendChildren(messagesContainer, renderMessage(message))
            })
            if (messages.length > 0) {
                markUnread()
            }
            scrollToBottom()
            serviceLifecycle.own(chatService.subscribe({
                onMessageAdded: (message: ChatMessage) => {
                    appendChildren(messagesContainer, renderMessage(message))
                    scrollToBottom()
                    markUnread()
                }
            }))
        } else {
            element.classList.add("hidden")
            element.classList.remove("open")
            updateTabIcon()
        }
    }))
    element.classList.add("hidden")
    return element
}
