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
            .delete-action-btn:hover { opacity: 0.8; }
            .delete-action-btn:active { transform: translateY(1px); }
            .cancel-action-btn:hover { background: var(--bg-surface-3) !important; }
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
                        color: "var(--text-primary)",
                        position: "relative",
                        overflow: "hidden" // Ensure slide effects stay contained
                    }}
                        onclick={() => {
                            service.loadSession(session.id)
                            onClose()
                        }}>
                        <div style={{ fontSize: "13px", color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {session.title || "Untitled Chat"}
                        </div>
                        <div className="meta-row" style={{ fontSize: "11px", color: "var(--text-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center", height: "20px" }}>
                            <span>{new Date(session.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>

                            {/* Standard Delete Trigger */}
                            <span className="delete-trigger"
                                style={{
                                    opacity: "0", transition: "opacity 0.2s", fontSize: "14px", cursor: "pointer",
                                    padding: "2px 6px", borderRadius: "4px"
                                }}
                                onclick={(e: any) => {
                                    e.stopPropagation()
                                    // Show Confirm overlay
                                    const overlay = item.querySelector(".confirm-overlay") as HTMLElement
                                    if (overlay) overlay.style.display = "flex"
                                }}
                            >🗑</span>
                        </div>

                        {/* Confirmation Overlay (Initially Hidden) */}
                        <div className="confirm-overlay" style={{
                            display: "none",
                            position: "absolute", top: "0", left: "0", right: "0", bottom: "0",
                            background: "var(--bg-surface-2)", // Match hover state
                            alignItems: "center", justifyContent: "flex-end",
                            padding: "0 12px", gap: "8px",
                            zIndex: "10"
                        }} onclick={(e) => e.stopPropagation()}>

                            <button className="cancel-action-btn" style={{
                                background: "none", border: "1px solid var(--border-dim)", color: "var(--text-primary)",
                                padding: "4px 10px", borderRadius: "4px", fontSize: "11px", cursor: "pointer",
                                transition: "all 0.1s"
                            }} onclick={(e) => {
                                e.stopPropagation()
                                const overlay = item.querySelector(".confirm-overlay") as HTMLElement
                                if (overlay) overlay.style.display = "none"
                            }}>Cancel</button>

                            <button className="delete-action-btn" style={{
                                background: "var(--color-red)", border: "none", color: "white",
                                padding: "4px 12px", borderRadius: "4px", fontSize: "11px", cursor: "pointer", fontWeight: "600",
                                transition: "all 0.1s"
                            }} onclick={(e) => {
                                // [ANTIGRAVITY] Removed preventDefault to ensure native click behavior
                                e.stopPropagation()
                                console.log("🗑 DELETING SESSION:", session.id)
                                chatHistory.deleteSession(session.id)
                            }}>Delete</button>
                        </div>

                    </div> as HTMLElement

                    // Show delete trigger on hover
                    item.onmouseenter = () => {
                        const trigger = item.querySelector(".delete-trigger") as HTMLElement
                        if (trigger) trigger.style.opacity = "0.7"
                    }
                    item.onmouseleave = () => {
                        const trigger = item.querySelector(".delete-trigger") as HTMLElement
                        if (trigger) trigger.style.opacity = "0"
                    }

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
