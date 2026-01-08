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
    securityLevel: 'loose',
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

// Custom Styling for Markdown Output (injected into a style tag or inline)
// ideally this would be in a CSS file, but for self-contained component:
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
                {isUser ? "YOU" : "ODIE"}
            </div>

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
                                    return (
                                        <div key={index} className="odie-widget-container" style={{ pointerEvents: "auto" }}>
                                            {OdieRenderEngine.render(fragment, (action: any) => {
                                                // Bridge widget actions to OdieService
                                                if (onWidgetAction) onWidgetAction(action)
                                            })}
                                        </div>
                                    )
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
                                triggerGlow(e.currentTarget, "#4ade80") // Green glow
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
                                triggerGlow(e.currentTarget, "#f87171") // Red glow
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
                                triggerGlow(e.currentTarget, "#c084fc") // Purple glow
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

// 🎨 Image Modal with Download
const showImageModal = (imageSrc: string) => {
    // Create modal overlay
    const modal = document.createElement('div')
    modal.className = 'odie-image-modal'

    // Image
    const img = document.createElement('img')
    img.src = imageSrc

    // Actions
    const actions = document.createElement('div')
    actions.className = 'odie-image-modal-actions'

    // Download button
    const downloadBtn = document.createElement('button')
    downloadBtn.className = 'odie-image-modal-btn'
    downloadBtn.innerHTML = 'Download Image'
    downloadBtn.onclick = () => {
        const link = document.createElement('a')
        link.href = imageSrc
        link.download = `odie-image-${Date.now()}.png`
        link.click()
    }

    // Close button
    const closeBtn = document.createElement('button')
    closeBtn.className = 'odie-image-modal-btn'
    closeBtn.innerHTML = 'Close'
    closeBtn.onclick = () => modal.remove()

    actions.appendChild(downloadBtn)
    actions.appendChild(closeBtn)
    modal.appendChild(img)
    modal.appendChild(actions)

    // Click outside to close
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove()
    })

    // Escape to close
    const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            modal.remove()
            document.removeEventListener('keydown', handleEscape)
        }
    }
    document.addEventListener('keydown', handleEscape)

    document.body.appendChild(modal)
}

interface ListProps {
    service: OdieService
}

export const OdieMessageList = ({ service }: ListProps) => {
    const container = <div className={className}></div> as HTMLElement

    // Auto-scroll logic with Sticky Bottom
    // We use a dummy element to scroll to
    const bottomAnchor = document.createElement("div")
    bottomAnchor.style.height = "1px"
    bottomAnchor.style.width = "100%"
    bottomAnchor.style.flexShrink = "0"

    const scrollToBottom = (instant = false) => {
        if (instant) {
            container.scrollTop = container.scrollHeight
        } else {
            // Use minimal delay to allow layout to settle
            requestAnimationFrame(() => {
                bottomAnchor.scrollIntoView({ behavior: "smooth", block: "end" })
            })
        }
    }

    const lifecycle = new Terminator()

    // We track the last message count to detect new messages vs updates
    let lastMessageCount = 0

    // State for Incremental Rendering
    let renderedCount = 0
    const renderedNodes: HTMLElement[] = []

    lifecycle.own(service.messages.catchupAndSubscribe(observable => {
        const messages = observable.getValue()
        const newCount = messages.length

        // 1. Capture Scroll State (Sticky Logic)
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100

        // 2. Diff & Patch
        if (newCount === 0) {
            // -- RESET --
            container.innerHTML = ""
            renderedNodes.length = 0
            renderedCount = 0

            // Render Empty State
            const emptyState = <div className="EmptyState">
                <div className="RobotIcon"><Icon symbol={IconSymbol.Robot} style={{ fontSize: "2em" }} /></div>
                <div className="Title">ODIE ONLINE</div>
                <div className="Subtitle">Awaiting Input...</div>
                <div className="ActionContainer">
                    <button
                        onclick={() => odieFeedback.export().then(count => alert(`Exported ${count} feedback logs.`))}
                        className="ExportButton"
                    >
                        Export Logs
                    </button>
                </div>
            </div>
            container.appendChild(emptyState)

        } else if (newCount < renderedCount) {
            // -- UNEXPECTED SHRINK (e.g. Deletion) --
            // Fallback to full rebuild for safety
            container.innerHTML = ""
            renderedNodes.length = 0
            renderedCount = 0
            // Recursively handle as "from scratch"
            messages.forEach(msg => appendMessage(msg))

        } else {
            // -- INCREMENTAL UPDATE --

            // A. Remove Empty State if it exists (first message arrival)
            if (renderedCount === 0 && newCount > 0) {
                container.innerHTML = ""
            }

            // B. Handle Streaming Update (Last message changed?)
            // If the count is the same, it means the last message might have updated text.
            // If the count grew, the previous "last" message is technically "done", so we leave it alone
            // and append the new ones.
            // CAUTION: In some cases, previous messages *could* change (e.g. status updates).
            // But for Odie, usually only the last one is active.
            // Optimization: dynamic replacement of the last node if count matches.

            if (newCount === renderedCount && renderedCount > 0) {
                // FAST PATH: Re-render ONLY the last message
                const lastIdx = newCount - 1
                const lastMsg = messages[lastIdx]
                const newBubble = createBubble(lastMsg)

                const oldNode = renderedNodes[lastIdx]
                if (oldNode && oldNode.parentNode === container) {
                    container.replaceChild(newBubble, oldNode)
                    renderedNodes[lastIdx] = newBubble
                } else {
                    // Should not happen, but safe fallback
                    container.appendChild(newBubble)
                    renderedNodes[lastIdx] = newBubble
                }
            } else {
                // C. Append New Messages
                // start from renderedCount
                for (let i = renderedCount; i < newCount; i++) {
                    appendMessage(messages[i])
                }
            }

            // D. Ensure Anchor is last
            if (bottomAnchor.parentNode !== container) {
                container.appendChild(bottomAnchor)
            } else {
                // If we appended nodes, anchor might not be last anymore in DOM order?
                // Actually appendChild moves it. So effectively re-appending it ensures it's at the bottom.
                container.appendChild(bottomAnchor)
            }
        }

        // Update Valid State
        renderedCount = newCount

        // 3. Scroll Logic
        if (newCount > lastMessageCount || isNearBottom) {
            requestAnimationFrame(() => {
                requestAnimationFrame(() => scrollToBottom(newCount > lastMessageCount))
            })
        }
        lastMessageCount = newCount

        // 4. Post-Render Effects (Mermaid, Images) - Debounced
        // We only need to run this on the NEW or UPDATED nodes ideally, but running on all is cheap enough if cached.
        setTimeout(() => {
            mermaid.run({ nodes: container.querySelectorAll('.mermaid') })
                .catch(e => console.error("Mermaid Err", e))

            // Re-bind images (idempotent listeners would be better, but this is okay for now)
            const images = container.querySelectorAll('.odie-markdown img')
            images.forEach(img => {
                // Hack to avoid double-binding: check class? 
                // Actually, purely functional usage: we can just re-bind. 
                // 'click' adds up? Yes. 
                // Better: check if we already handled it.
                if (!(img as any)._odieModalBound) {
                    img.addEventListener('click', () => showImageModal((img as HTMLImageElement).src));
                    (img as any)._odieModalBound = true
                }
            })
        }, 50)

    }))

    // Helper to create and append
    const createBubble = (msg: Message) => {
        return MessageBubble({
            message: msg,
            onRetry: (text) => service.sendMessage(text),
            onWidgetAction: (action) => service.handleWidgetAction(action)
        }) as HTMLElement
    }

    const appendMessage = (msg: Message) => {
        const node = createBubble(msg)
        container.appendChild(node)
        renderedNodes.push(node)
    }

    // -- History Drawer Injection (Service-Driven) --
    interface HistoryPanelElement extends HTMLElement {
        cleanup?: () => void
    }

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
        } else {
            if (historyPanel) {
                if (historyPanel.cleanup) historyPanel.cleanup()
                historyPanel.remove()
                historyPanel = null
            }
        }
    }

    // Subscribe to service toggle
    lifecycle.own(service.showHistory.subscribe(obs => syncHistory(obs.getValue())))
    // Initial Sync
    syncHistory(service.showHistory.getValue())

    return container
}
