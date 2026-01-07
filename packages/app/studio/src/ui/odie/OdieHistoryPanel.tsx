import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { chatHistory, ChatSession } from "./services/ChatHistoryService"

interface PanelProps {
    service: OdieService
    onClose: () => void
}

export const OdieHistoryPanel = ({ service, onClose }: PanelProps) => {

    // Subscribe to history updates
    const redraw = () => {
        const root = document.getElementById("odie-history-list")
        if (root) {
            root.innerHTML = ""
            renderList(root)
        }
    }

    // Main Container
    const container = <div className="HistoryPanel" style={{
        flex: "1",
        display: "flex", flexDirection: "column",
        background: "var(--bg-surface-0)",
        overflow: "hidden"
    }}>
        <style>{`
            .history-item:hover { background: var(--bg-surface-2); }
        `}</style>
    </div> as HTMLElement

    // Header
    const header = <div style={{
        padding: "16px",
        borderBottom: "1px solid var(--border-dim)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexShrink: "0"
    }}>
        <div style={{ fontWeight: "600", fontSize: "14px", color: "var(--text-primary)" }}>History</div>
        <button onclick={onClose} style={{
            background: "none", border: "none",
            color: "var(--text-secondary)", cursor: "pointer", fontSize: "16px",
            padding: "4px", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center"
        }}>✕</button>
    </div>
    container.appendChild(header)

    // List Container
    const listContainer = <div id="odie-history-list" style={{
        flex: "1", overflowY: "auto", padding: "12px"
    }}></div>
    container.appendChild(listContainer)

    // Render Logic
    const renderList = (root: HTMLElement) => {
        const groups = chatHistory.getGroupedSessions()

            ; (Object.entries(groups) as [string, ChatSession[]][]).forEach(([groupName, sessions]) => {
                if (sessions.length === 0) return

                const groupHeader = <div style={{
                    fontSize: "11px", fontWeight: "700", color: "#64748b",
                    textTransform: "uppercase", padding: "12px 8px 4px 8px"
                }}>{groupName}</div>
                root.appendChild(groupHeader)

                sessions.forEach(session => {
                    const item = <div className="history-item" style={{
                        padding: "10px 12px", borderRadius: "6px",
                        cursor: "pointer", display: "flex", flexDirection: "column", gap: "2px",
                        transition: "background 0.1s",
                        margin: "0 0 2px 0",
                        color: "var(--text-primary)"
                    }}
                        onclick={() => {
                            service.loadSession(session.id)
                            onClose() // Switches back to chat
                        }}>
                        <div style={{ fontSize: "13px", color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {session.title || "Untitled Chat"}
                        </div>
                        <div style={{ fontSize: "11px", color: "var(--text-tertiary)", display: "flex", justifyContent: "space-between" }}>
                            <span>{new Date(session.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            <span
                                style={{ color: "var(--color-red)", opacity: "0", transition: "opacity 0.2s", fontSize: "12px", cursor: "pointer" }}
                                onclick={(e: any) => {
                                    e.stopPropagation()
                                    const target = e.target as HTMLElement
                                    // Switch to confirm mode
                                    if (target.innerText === "🗑") {
                                        target.innerText = "Confirm?"
                                        target.style.opacity = "1"
                                        target.style.color = "var(--color-red)"

                                        // Auto-cancel after 3s
                                        setTimeout(() => {
                                            if (target.innerText !== "🗑") {
                                                target.innerText = "🗑"
                                                target.style.opacity = "0"
                                            }
                                        }, 3000)
                                    } else {
                                        // Confirmed
                                        chatHistory.deleteSession(session.id)
                                    }
                                }}
                                onmouseenter={(e: any) => {
                                    if (e.target.innerText === "🗑") e.target.style.opacity = "1"
                                }}
                            >🗑</span>
                        </div>
                    </div> as HTMLElement

                    // Show delete on hover
                    item.onmouseenter = () => { (item.lastChild!.lastChild as HTMLElement).style.opacity = "0.5" }
                    item.onmouseleave = () => { (item.lastChild!.lastChild as HTMLElement).style.opacity = "0" }

                    root.appendChild(item)
                })
            })
    }

    renderList(listContainer as HTMLElement)

    // React to changes
    const binding = chatHistory.sessions.subscribe(() => redraw())

    // Cleanup helper attached to container
    const cleanupContainer = container as HTMLElement & { cleanup?: () => void }
    cleanupContainer.cleanup = () => binding.terminate()

    return container
}
