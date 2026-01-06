import { createElement } from "@opendaw/lib-jsx"
import { Message } from "./services/llm/LLMProvider"
import { OdieService, odieService } from "./OdieService"
import { Terminator } from "@opendaw/lib-std"
import MarkdownIt from "markdown-it"
import mermaid from "mermaid"
import { odieFeedback } from "./services/OdieFeedbackService"

import { OdieRenderEngine } from "./OdieRenderEngine"

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
// @ts-ignore
const defaultLinkRenderer = md.renderer.rules.link_open || function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
};
// @ts-ignore
md.renderer.rules.link_open = function (tokens: any, idx: any, options: any, _env: any, self: any) {
    // Add target="_blank" and rel="noopener noreferrer"
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkRenderer(tokens, idx, options, _env, self);
};

// Custom Styling for Markdown Output (injected into a style tag or inline)
// ideally this would be in a CSS file, but for self-contained component:
const MARKDOWN_STYLES = `
    .odie-markdown { 
        line-height: 1.6; 
        font-size: 14px; 
        color: #e2e8f0; 
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
    }
    
    /* Headings */
    .odie-markdown h1, .odie-markdown h2, .odie-markdown h3 {
        color: #f8fafc; margin-top: 1em; margin-bottom: 0.5em; font-weight: 700;
        letter-spacing: -0.02em;
    }
    .odie-markdown h1 { font-size: 1.4em; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px; }
    .odie-markdown h2 { font-size: 1.2em; }
    .odie-markdown h3 { font-size: 1.1em; color: #94a3b8; }
    
    /* Paragraphs */
    .odie-markdown p { margin-top: 0; margin-bottom: 0.8em; }
    .odie-markdown p:last-child { margin-bottom: 0; }
    
    /* Spans */
    .odie-markdown strong { color: #f472b6; font-weight: 600; text-shadow: 0 0 10px rgba(244, 114, 182, 0.2); } 
    .odie-markdown em { color: #cbd5e1; font-style: italic; }
    
    /* Links */
    .odie-markdown a { 
        color: #38bdf8; 
        text-decoration: none; 
        border-bottom: 1px solid rgba(56, 189, 248, 0.3);
        transition: all 0.2s;
        font-weight: 500;
    }
    .odie-markdown a:hover { 
        color: #7dd3fc; 
        border-bottom-color: #7dd3fc;
        text-shadow: 0 0 8px rgba(56, 189, 248, 0.4);
    }
    
    /* Lists */
    .odie-markdown ul, .odie-markdown ol { margin-left: 1.2em; margin-bottom: 1em; padding-left: 0; }
    .odie-markdown li { margin-bottom: 0.3em; marker-color: #64748b; }
    
    /* Code Inline */
    .odie-markdown code { 
        background: rgba(15, 23, 42, 0.6); 
        border: 1px solid rgba(255,255,255,0.1);
        padding: 2px 5px; 
        border-radius: 4px; 
        font-family: 'JetBrains Mono', 'Fira Code', monospace; 
        font-size: 0.85em;
        color: #e2e8f0;
    }
    
    /* Code Blocks */
    .odie-markdown pre { 
        background: #0b0f19; 
        padding: 16px; 
        border-radius: 8px; 
        overflow-x: auto; 
        margin: 12px 0;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: inset 0 2px 4px rgba(0,0,0,0.3);
    }
    .odie-markdown pre code {
        background: transparent;
        padding: 0;
        border: none;
        color: #e2e8f0;
        font-size: 0.85em;
        text-shadow: none;
    }
    
    /* Blockquotes */
    .odie-markdown blockquote { 
        border-left: 3px solid #6366f1; 
        padding: 4px 12px;
        margin: 12px 0;
        font-style: italic;
        background: linear-gradient(to right, rgba(99, 102, 241, 0.1), transparent);
        border-radius: 0 4px 4px 0;
        color: #cbd5e1;
    }


    /* Tables */
    .odie-markdown table {
        width: 100%;
        border-collapse: collapse;
        margin: 16px 0;
        background: rgba(255, 255, 255, 0.02);
        border-radius: 8px;
        overflow: hidden;
    }
    .odie-markdown th {
        text-align: left;
        padding: 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        color: #94a3b8;
        font-weight: 600;
        font-size: 0.9em;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: rgba(0, 0, 0, 0.2);
    }
    .odie-markdown td {
        padding: 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        vertical-align: top;
    }
    .odie-markdown tr:last-child td { border-bottom: none; }
    .odie-markdown tr:hover td { background: rgba(255, 255, 255, 0.02); }

    /* AI Generated Images */
    .odie-markdown img {
        max-width: 100%;
        height: auto;
        border-radius: 12px;
        margin: 12px 0;
        cursor: pointer;
        transition: transform 0.2s, box-shadow 0.2s;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .odie-markdown img:hover {
        transform: scale(1.02);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    /* Image Modal */
    .odie-image-modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.9);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        padding: 20px;
    }
    .odie-image-modal img {
        max-width: 90vw;
        max-height: 80vh;
        border-radius: 8px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    }
    .odie-image-modal-actions {
        display: flex;
        gap: 16px;
        margin-top: 20px;
    }
    .odie-image-modal-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #fff;
        padding: 10px 20px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        transition: all 0.2s;
    }
    .odie-image-modal-btn:hover {
        background: rgba(255, 255, 255, 0.2);
        transform: translateY(-2px);
    }

    /* Thinking Animation */
    @keyframes odie-think {
        0%, 100% { opacity: 0.3; transform: scale(0.8); }
        50% { opacity: 1; transform: scale(1); }
    }
    .odie-think-dot {
        display: inline-block;
        width: 6px; height: 6px;
        background: currentColor;
        border-radius: 50%;
        margin: 0 2px;
        animation: odie-think 1.4s infinite both;
    }
    .odie-think-dot:nth-child(1) { animation-delay: -0.32s; }
    .odie-think-dot:nth-child(2) { animation-delay: -0.16s; }
`

const MessageBubble = ({ message, onRetry }: { message: Message, onRetry?: (text: string) => void }) => {
    const isUser = message.role === "user"
    const isModel = message.role === "model"
    const isThinking = isModel && !message.content

    // Cyber-Studio Palette
    const colors = {
        userBg: "linear-gradient(135deg, #1e40af 0%, #3b82f6 100%)", // Vibrant Blue
        odieBg: "#1e293b", // Slate 800
        text: isUser ? "#f8fafc" : "#e2e8f0",
        border: isUser ? "none" : "1px solid rgba(255,255,255,0.1)"
    }

    const containerStyle = {
        alignSelf: isUser ? "flex-end" : "flex-start",
        background: isUser ? colors.userBg : colors.odieBg,
        color: colors.text,
        border: colors.border,
        marginLeft: isUser ? "20%" : "0",
        marginRight: "0", // Always 0 right margin (user is auto/flex-end, odie is full width)
        padding: "12px 16px",
        borderRadius: isUser ? "16px 16px 2px 16px" : "16px 16px 16px 2px", // Distinct shapes
        marginBottom: "16px",
        fontSize: "14px",
        lineHeight: "1.5",
        boxShadow: isUser
            ? "0 4px 12px rgba(37, 99, 235, 0.2)"
            : "0 2px 8px rgba(0,0,0,0.2)",
        position: "relative",
        maxWidth: isUser ? "80%" : "100%", // User keeps constraint, Odie goes full
        width: isUser ? "auto" : "100%", // Odie takes full width
        transition: "transform 0.2s ease",
        fontFamily: "'Inter', sans-serif"
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", width: "100%" }}>
            {/* Avatar Label (Optional) */}
            <div style={{
                fontSize: "10px",
                marginBottom: "4px",
                marginLeft: isUser ? "0" : "12px",
                marginRight: isUser ? "12px" : "0",
                opacity: "0.5",
                fontWeight: "600",
                letterSpacing: "0.5px"
            }}>
                {isUser ? "YOU" : "ODIE"}
            </div>

            <div style={containerStyle} className="odie-message-bubble">
                {/* Content or Thinking */}
                {isThinking ? (
                    <div style={{ display: "flex", alignItems: "center", gap: "2px", padding: "4px 0" }}>
                        <div className="odie-think-dot"></div>
                        <div className="odie-think-dot"></div>
                        <div className="odie-think-dot"></div>
                    </div>
                ) : (
                    <div>
                        {(() => {
                            // 1. Process Status Codes (Strip from UI, keep in data for tests)
                            const displayContent = (message.content || "")
                                .replace(/\[\[STATUS:.*?\]\]/gi, "")
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
                                                odieService.handleWidgetAction(action)
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
                    <div style={{
                        display: "flex",
                        gap: "8px",
                        marginTop: "8px",
                        paddingTop: "4px",
                        borderTop: "1px solid rgba(255,255,255,0.1)",
                        justifyContent: "flex-end",
                        opacity: "0.8"
                    }}>
                        <ActionButton
                            icon="📋"
                            label="Copy"
                            onClick={(e) => {
                                navigator.clipboard.writeText(message.content)
                                triggerGlow(e.currentTarget)
                            }}
                        />
                        <ActionButton
                            icon="↻"
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
                    <div style={{
                        display: "flex",
                        gap: "12px",
                        marginTop: "12px",
                        paddingTop: "8px",
                        borderTop: "1px solid rgba(255,255,255,0.05)",
                        opacity: "0.6"
                    }}>
                        <ActionButton
                            icon="📋"
                            label="Copy"
                            onClick={(e) => {
                                navigator.clipboard.writeText(message.content)
                                triggerGlow(e.currentTarget)
                            }}
                        />
                        <ActionButton
                            icon="👍"
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
                            icon="👎"
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
                            icon="💬"
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

    setTimeout(() => {
        element.style.transition = "all 0.5s ease"
        element.style.boxShadow = "none"
        element.style.color = "inherit"
        element.style.transform = "scale(1)"
    }, 200)
}

const ActionButton = ({ icon, label, onClick }: { icon: string, label?: string, onClick: (e: any) => void }) => {
    return (
        <button
            onclick={onClick}
            style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                fontSize: "12px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 4px",
                borderRadius: "4px",
                transition: "all 0.2s"
            }}
            title={label || icon}
            onmouseenter={(e: any) => e.target.style.opacity = "1"}
            onmouseleave={(e: any) => e.target.style.opacity = "0.7"}
        >
            <span>{icon}</span> {label}
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
    downloadBtn.innerHTML = '⬇️ Download Image'
    downloadBtn.onclick = () => {
        const link = document.createElement('a')
        link.href = imageSrc
        link.download = `odie-image-${Date.now()}.png`
        link.click()
    }

    // Close button
    const closeBtn = document.createElement('button')
    closeBtn.className = 'odie-image-modal-btn'
    closeBtn.innerHTML = '✕ Close'
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
    const container = <div className="odie-message-list-scroll-area" style={{
        flex: "1",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
        minHeight: "0",
        padding: "20px",
        background: "rgba(15, 23, 42, 0.6)", // Semi-transparent Slate 900
        backdropFilter: "blur(12px)",
        gap: "8px",
        position: "relative",
        scrollBehavior: "smooth",
        width: "100%"
    }}>
        <style>{MARKDOWN_STYLES}</style>
    </div> as HTMLElement

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

    lifecycle.own(service.messages.catchupAndSubscribe(observable => {
        // 1. Capture Scroll State BEFORE clearing DOM
        // If we are near bottom (stickiness), we want to stay there.
        // We use a generous threshold (100px) because line-heights vary.
        const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100

        const messages = observable.getValue()
        // Clear except style tag. Actually simpler to just rebuild.
        container.innerHTML = `<style>${MARKDOWN_STYLES}</style>`

        if (messages.length === 0) {
            const emptyState = <div style={{
                textAlign: "center",
                opacity: "0.4",
                marginTop: "40%",
                color: "#94a3b8"
            }}>
                <div style={{ fontSize: "64px", marginBottom: "16px", filter: "drop-shadow(0 0 20px rgba(96, 165, 250, 0.2))" }}>🤖</div>
                <div style={{ fontWeight: "500", letterSpacing: "1px" }}>ODIE ONLINE</div>
                <div style={{ fontSize: "12px", marginTop: "8px" }}>Awaiting Input...</div>

                {/* Export Button (Subtle) */}
                <div style={{ marginTop: "32px" }}>
                    <button
                        onclick={() => odieFeedback.export().then(count => alert(`Exported ${count} feedback logs.`))}
                        style={{
                            background: "transparent",
                            border: "1px solid rgba(255,255,255,0.1)",
                            color: "rgba(255,255,255,0.3)",
                            fontSize: "10px",
                            padding: "4px 8px",
                            borderRadius: "4px",
                            cursor: "pointer"
                        }}
                    >
                        ⬇ Export Logs
                    </button>
                </div>
            </div>
            container.appendChild(emptyState)
        } else {
            messages.forEach(msg => {
                // Pass a callback for Retry
                container.appendChild(MessageBubble({
                    message: msg,
                    onRetry: (text) => service.sendMessage(text)
                }))
            })

            // Append the anchor last
            container.appendChild(bottomAnchor)

            // Scroll Logic
            const isNewMessage = messages.length > lastMessageCount
            lastMessageCount = messages.length

            if (isNewMessage || isNearBottom) {
                // Use double RAF to ensure paint cycle is complete
                // We use 'instant' (true) for new messages to snap, and 'smooth' (false) for streaming
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => scrollToBottom(isNewMessage))
                })
            }


            // Post-Render Actions (Mermaid, Images)
            setTimeout(() => {
                // Render Mermaid Diagrams
                mermaid.run({
                    nodes: container.querySelectorAll('.mermaid')
                }).catch(err => console.error("Mermaid Render Error", err))

                // 🎨 Make AI-generated images clickable
                const images = container.querySelectorAll('.odie-markdown img')
                images.forEach(img => {
                    img.addEventListener('click', () => {
                        showImageModal((img as HTMLImageElement).src)
                    })
                })
            }, 50)
        }
    }))

    // -- History Drawer Injection (Service-Driven) --
    let historyPanel: HTMLElement | null = null
    const syncHistory = (show: boolean) => {
        if (show) {
            if (!historyPanel) {
                import("./OdieHistoryPanel").then(({ OdieHistoryPanel }) => {
                    historyPanel = OdieHistoryPanel({
                        service,
                        onClose: () => service.showHistory.setValue(false)
                    })
                    container.appendChild(historyPanel)
                })
            }
        } else {
            if (historyPanel) {
                // @ts-ignore
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
