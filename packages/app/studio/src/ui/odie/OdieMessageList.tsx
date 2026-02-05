import { createElement } from "@opendaw/lib-jsx"
import { Message } from "./services/llm/LLMProvider"
import { OdieService } from "./OdieService"
import { Terminator } from "@opendaw/lib-std"
import MarkdownIt from "markdown-it"
import mermaid from "mermaid"
import { odieFeedback } from "./services/OdieFeedbackService"

import { OdieRenderEngine } from "./OdieRenderEngine"
import { IconSymbol } from "@opendaw/studio-enums"
import { Icon } from "@/ui/components/Icon"

// Initialize Mermaid
mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'strict',
})

// Initialize Markdown Parser
const md: any = new MarkdownIt({
    html: false, // Security: Disable HTML tags in source
    breaks: true,
    linkify: true,
    typographer: true,
    highlight: (str: string, lang: string) => {
        if (lang === 'mermaid') {
            return `<div class="mermaid">${str}</div>`
        }
        return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`
    }
})

// Open links in new tab
const defaultLinkRenderer = md.renderer.rules.link_open || function (tokens: any, idx: any, options: any, _env: any, self: any) {
    return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_open = function (tokens: any, idx: any, options: any, _env: any, self: any) {
    // Add target="_blank" and rel="noopener noreferrer"
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkRenderer(tokens, idx, options, _env, self);
};

// Custom Styling for Markdown Output
import css from "./OdieMessageList.sass?inline"
import { Html } from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "OdieMessageList")

const MessageBubble = ({ message, onRetry, onWidgetAction }: { message: Message, onRetry?: (text: string) => void, onWidgetAction?: (action: any) => void }) => {
    const isUser = message.role === "user"
    const isModel = message.role === "model"
    const isThinking = isModel && !message.content

    return (
        <div className={`MessageEntry ${isUser ? "User" : "Odie"}`}>
            {/* Avatar Label (Optional) */}
            <div className="AvatarLabel">
                {isUser ? "You" : "Odie"}
            </div>

            {/* Thoughts (Reasoning Models) */}
            {message.thoughts && message.thoughts.trim().length > 0 && (
                <details className="OdieThoughts">
                    <summary>Thought Process</summary>
                    <div className="ThoughtContent">
                        {message.thoughts}
                    </div>
                </details>
            )}

            <div className={`MessageBubble ${isUser ? "User" : "Odie"} odie-message-bubble`}>
                {/* Content or Thinking */}
                {isThinking ? (
                    <div className="ThinkingContainer">
                        <div className="odie-think-dot"></div>
                        <div className="odie-think-dot"></div>
                        <div className="odie-think-dot"></div>
                    </div>
                ) : (
                    <div>
                        {(() => {
                            // 1. Process Status Codes (Strip from UI, keep in data for tests)
                            const displayContent = (message.content || "")
                                .replace(/\[{1,2}STATUS:.*?\]{1,2}/gi, "")
                                .trim()

                            // 2. Parse Fragments (Text + Widgets)
                            const fragments = OdieRenderEngine.parseFragments(displayContent)

                            return fragments.map((fragment, index) => {
                                if (typeof fragment === "string") {
                                    // Render Markdown Text
                                    if (!fragment.trim()) return null // Skip empty
                                    const html = md.render(fragment)
                                    return <div key={index} className="odie-markdown" innerHTML={html} />
                                } else {
                                    // Render Widget with onAction callback for interactivity
                                    try {
                                        return (
                                            <div key={index} className="odie-widget-container" style={{ pointerEvents: "auto" }}>
                                                {OdieRenderEngine.render(fragment, (action: any) => {
                                                    // Bridge widget actions to OdieService
                                                    if (onWidgetAction) onWidgetAction(action)
                                                })}
                                            </div>
                                        )
                                    } catch (e) {
                                        console.error("Widget Render Error:", e)
                                        return (
                                            <div key={index} className="odie-widget-error" style={{ padding: "8px", border: "1px solid red", color: "red", borderRadius: "4px" }}>
                                                ⚠️ Widget failed to load.
                                            </div>
                                        )
                                    }
                                }
                            })
                        })()}
                    </div>
                )}

                {/* USER Actions: Copy / Retry */}
                {isUser && (
                    <div className="ActionRow">
                        <ActionButton
                            symbol={IconSymbol.NotePad}
                            label="Copy"
                            onClick={(e) => {
                                navigator.clipboard.writeText(message.content)
                                triggerGlow(e.currentTarget)
                            }}
                        />
                        <ActionButton
                            symbol={IconSymbol.Undo}
                            label="Retry"
                            onClick={(e) => {
                                if (onRetry) onRetry(message.content)
                                triggerGlow(e.currentTarget)
                            }}
                        />
                    </div>
                )}

                {/* ODIE Actions (Only for Odie and if not thinking) */}
                {!isUser && !isThinking && (
                    <div className="ActionRow Odie">
                        <ActionButton
                            symbol={IconSymbol.NotePad}
                            label="Copy"
                            onClick={(e) => {
                                navigator.clipboard.writeText(message.content)
                                triggerGlow(e.currentTarget)
                            }}
                        />
                        <ActionButton
                            symbol={IconSymbol.Connected}
                            onClick={(e) => {
                                odieFeedback.log({
                                    userMessage: "Unknown (Contextual)",
                                    odieResponse: message.content,
                                    rating: 'positive'
                                })
                                triggerGlow(e.currentTarget, "#73edb0") // Green glow
                            }}
                        />
                        <ActionButton
                            symbol={IconSymbol.Disconnected}
                            onClick={(e) => {
                                odieFeedback.log({
                                    userMessage: "Unknown (Contextual)",
                                    odieResponse: message.content,
                                    rating: 'negative'
                                })
                                triggerGlow(e.currentTarget, "#ff4d5e") // Red glow
                            }}
                        />
                        <ActionButton
                            symbol={IconSymbol.Help}
                            label="Feedback"
                            onClick={(e) => {
                                const fb = prompt("How can we improve this response?")
                                if (fb) {
                                    odieFeedback.log({
                                        userMessage: "Unknown (Contextual)",
                                        odieResponse: message.content,
                                        rating: 'negative', // Assume constructive criticism is usually corrective
                                        comment: fb
                                    })
                                }
                                triggerGlow(e.currentTarget, "#4de4ff") // Cyan glow
                            }}
                        />
                    </div>
                )}
            </div>
        </div>
    )
}

// -- Helper for the Action Buttons & Glow Effect --

const triggerGlow = (element: HTMLElement, color: string = "#3b82f6") => {
    element.style.transition = "none"
    element.style.boxShadow = `0 0 15px ${color}, inset 0 0 10px ${color}`
    element.style.color = "#fff"
    element.style.transform = "scale(1.05)"
    element.style.opacity = "1"

    setTimeout(() => {
        element.style.transition = "all 0.5s ease"
        element.style.boxShadow = "none"
        // element.style.color = "inherit" // Do not reset color immediately for feedback
        element.style.transform = "scale(1)"
        // element.style.opacity = "0.7" // Let CSS hover handle this
    }, 200)
}

const ActionButton = ({ symbol, label, onClick }: { symbol: IconSymbol, label?: string, onClick: (e: any) => void }) => {
    return (
        <button
            className="ActionButton"
            onclick={onClick}
            title={label || IconSymbol.toName(symbol)}
        >
            <Icon symbol={symbol} /> {label && <span>{label}</span>}
        </button>
    )
}

// 🎨 Image Modal
const showImageModal = (imageSrc: string) => {
    const modal = document.createElement('div')
    modal.className = 'odie-image-modal'

    const img = document.createElement('img')
    img.src = imageSrc

    const actions = document.createElement('div')
    actions.className = 'odie-image-modal-actions'

    const downloadBtn = document.createElement('button')
    downloadBtn.className = 'odie-image-modal-btn'
    downloadBtn.innerText = 'Download'
    downloadBtn.onclick = () => {
        const link = document.createElement('a')
        link.href = imageSrc
        link.download = `odie-image-${Date.now()}.png`
        link.click()
    }

    const closeBtn = document.createElement('button')
    closeBtn.className = 'odie-image-modal-btn'
    closeBtn.innerText = 'Close'
    const removeModal = () => {
        modal.remove()
        document.removeEventListener('keydown', handleEscape)
    }
    const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            removeModal()
        }
    }
    modal.onclick = (e) => { if (e.target === modal) removeModal() }
    closeBtn.onclick = () => removeModal()

    actions.appendChild(downloadBtn)
    actions.appendChild(closeBtn)
    modal.appendChild(img)
    modal.appendChild(actions)

    document.addEventListener('keydown', handleEscape)
    document.body.appendChild(modal)
}

interface ListProps {
    service: OdieService
}

export const OdieMessageList = ({ service }: ListProps) => {
    const container = <div className={className}></div> as HTMLElement

    const bottomAnchor = <div style={{ height: "1px", width: "100%", flexShrink: "0" }}></div> as HTMLElement

    const scrollToBottom = (instant = false) => {
        if (instant) {
            container.scrollTop = container.scrollHeight
        } else {
            requestAnimationFrame(() => bottomAnchor.scrollIntoView({ behavior: "smooth", block: "end" }))
        }
    }

    const lifecycle = new Terminator()
    let lastMessageCount = 0

    lifecycle.own(service.messages.catchupAndSubscribe(observable => {
        const messages = observable.getValue()
        const newCount = messages.length
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100

        container.innerHTML = ""

        if (newCount === 0) {
            container.appendChild(
                <div className="EmptyState">
                    <div className="Title">Odie</div>
                    <div className="Subtitle">Ask anything about your project...</div>
                </div> as HTMLElement
            )
        } else {
            messages.forEach(msg => {
                const bubble = <MessageBubble
                    message={msg}
                    onRetry={(text) => service.sendMessage(text)}
                    onWidgetAction={(action) => service.handleWidgetAction(action)}
                /> as HTMLElement
                container.appendChild(bubble)
            })
        }

        container.appendChild(bottomAnchor)

        if (newCount > lastMessageCount || isNearBottom) {
            requestAnimationFrame(() => scrollToBottom(newCount > lastMessageCount))
        }
        lastMessageCount = newCount

        setTimeout(() => {
            mermaid.run({ nodes: container.querySelectorAll('.mermaid') }).catch(() => { })
            container.querySelectorAll('.odie-markdown img').forEach(img => {
                if (!(img as any)._odieModalBound) {
                    img.addEventListener('click', () => showImageModal((img as HTMLImageElement).src))
                        ; (img as any)._odieModalBound = true
                }
            })
        }, 50)
    }))

    interface HistoryPanelElement extends HTMLElement { cleanup?: () => void }
    let historyPanel: HistoryPanelElement | null = null

    const syncHistory = (show: boolean) => {
        if (show) {
            if (!historyPanel) {
                import("./OdieHistoryPanel").then(({ OdieHistoryPanel }) => {
                    historyPanel = OdieHistoryPanel({
                        service,
                        onClose: () => service.showHistory.setValue(false)
                    }) as HistoryPanelElement
                    container.appendChild(historyPanel)
                })
            }
        } else if (historyPanel) {
            if (historyPanel.cleanup) historyPanel.cleanup()
            historyPanel.remove()
            historyPanel = null
        }
    }

    lifecycle.own(service.showHistory.subscribe(obs => syncHistory(obs.getValue())))
    syncHistory(service.showHistory.getValue())

    const res = container as HTMLElement & { cleanup?: () => void }
    res.cleanup = () => {
        lifecycle.terminate()
        if (historyPanel && historyPanel.cleanup) historyPanel.cleanup()
    }

    return res
}
