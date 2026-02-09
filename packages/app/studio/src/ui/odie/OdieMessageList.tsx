import { createElement } from "@opendaw/lib-jsx"
import { Message } from "./services/llm/LLMProvider"
import { OdieService } from "./OdieService"
import { Terminator } from "@opendaw/lib-std"
import MarkdownIt from "markdown-it"
import mermaid from "mermaid"

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
        <div className={`MessageEntry ${isUser ? "User" : "Odie"}`} role="article" aria-label={`${isUser ? "User" : "AI"} message`}>
            {/* Avatar Label (Optional) */}
            <div className="AvatarLabel" aria-hidden="true">
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
            type="button"
            className="ActionButton"
            onclick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onClick(e)
            }}
            title={label || (symbol !== undefined ? IconSymbol.toName(symbol) : "")}
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
    const messageWrapper = <div className="MessageWrapper" style={{ display: "flex", flexDirection: "column", width: "100%" }}></div> as HTMLElement
    const bottomAnchor = <div style={{ height: "1px", width: "100%", flexShrink: "0" }}></div> as HTMLElement

    container.appendChild(messageWrapper)

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

        // Optimization: Differential Update
        // 1. If messages cleared or reduced, full rebuild
        if (newCount < lastMessageCount) {
            messageWrapper.innerHTML = ""
            lastMessageCount = 0
        }

        // 2. If new empty state
        if (newCount === 0 && messageWrapper.children.length === 0) {
            messageWrapper.appendChild(
                <div className="EmptyState">
                    <div className="Title">Odie</div>
                    <div className="Subtitle">Ask anything about your project...</div>
                </div> as HTMLElement
            )
        }
        else if (newCount > 0) {
            // Remove empty state if present
            const emptyState = messageWrapper.querySelector(".EmptyState")
            if (emptyState) emptyState.remove()

            // 3. Update existing bubbles (if needed) or Append new ones
            // Simple heuristic: If count same, update last bubble (streaming). If count increased, append.
            const startIdx = newCount === lastMessageCount ? Math.max(0, newCount - 1) : lastMessageCount

            // Remove anchor momentarily to append before it? No, anchor is in wrapper.
            // Actually anchor needs to be at the very end.
            if (bottomAnchor.parentNode === messageWrapper) bottomAnchor.remove()

            for (let i = startIdx; i < newCount; i++) {
                const msg = messages[i]
                const bubble = <MessageBubble
                    message={msg}
                    onRetry={(text) => service.sendMessage(text)}
                    onWidgetAction={(action) => service.handleWidgetAction(action)}
                /> as HTMLElement

                // If updating last message (streaming), replace it
                if (i < lastMessageCount && messageWrapper.children[i]) {
                    messageWrapper.children[i].replaceWith(bubble)
                } else {
                    messageWrapper.appendChild(bubble)
                }
            }
        }

        // Ensure anchor is last
        messageWrapper.appendChild(bottomAnchor)

        if (newCount > lastMessageCount || (newCount === lastMessageCount && isNearBottom)) {
            // If streaming (same count), only scroll if we were near bottom
            if (isNearBottom || newCount > lastMessageCount) {
                requestAnimationFrame(() => scrollToBottom(newCount > lastMessageCount))
            }
        }
        lastMessageCount = newCount

        setTimeout(() => {
            mermaid.run({ nodes: messageWrapper.querySelectorAll('.mermaid') }).catch(() => { })
            messageWrapper.querySelectorAll('.odie-markdown img').forEach(img => {
                const element = img as HTMLImageElement
                if (!element.dataset.odieModalBound) {
                    element.addEventListener('click', () => showImageModal(element.src))
                    element.dataset.odieModalBound = "true"
                }
            })
        }, 50)
    }))

    // -- Component Feedback (Decoupled DOM) --
    const studioOpt = service.studio
    if (studioOpt.nonEmpty()) {
        lifecycle.own(studioOpt.unwrap().odieEvents.subscribe(event => {
            if (event.type === "ui-feedback" && event.targetId) {
                const gridEl = messageWrapper.querySelector(`#${event.targetId}`)
                const toastEl = gridEl?.querySelector(".grid-status-toast") as HTMLElement

                if (toastEl) {
                    toastEl.textContent = event.message
                    toastEl.style.opacity = "1"
                    setTimeout(() => {
                        if (toastEl) toastEl.style.opacity = "0"
                    }, 1500)
                }
            }
        }))
    }

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
