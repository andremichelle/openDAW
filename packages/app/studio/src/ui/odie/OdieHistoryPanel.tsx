import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { chatHistory } from "./services/ChatHistoryService"

interface PanelProps {
    service: OdieService
    onClose: () => void
}

export const OdieHistoryPanel = ({ service, onClose }: PanelProps) => {

    // Trace local state for which session is confirming delete
    // This serves as the single source of truth for the UI
    let pendingDeleteId: string | null = null

    const redraw = () => {
        if (listContainer) {
            listContainer.innerHTML = ""
            renderList(listContainer as HTMLElement)
        }
    }

    const container = <div className="HistoryPanel" style={{
        flex: "1",
        display: "flex", flexDirection: "column",
        background: "var(--bg-surface-0)",
        overflow: "hidden"
    }}>
        <style>{`
            .history-item {
                border: 1px solid var(--border-dim, rgba(255,255,255,0.1));
                margin-bottom: 6px;
            }
            .history-item:hover { 
                background: var(--bg-surface-2); 
                border-color: var(--text-tertiary, rgba(255,255,255,0.3));
            }
            .delete-action-btn:hover { opacity: 0.8; }
            .cancel-action-btn:hover { background: var(--bg-surface-3) !important; }
        `}</style>
    </div> as HTMLElement

    const header = <div style={{
        padding: "16px",
        borderBottom: "1px solid var(--border-dim)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexShrink: "0"
    }}>
        <div style={{ fontWeight: "600", fontSize: "14px", color: "var(--text-primary)" }}>History</div>
        <button onclick={onClose}
            aria-label="Close"
            style={{
                background: "none", border: "none",
                color: "var(--text-secondary)", cursor: "pointer", fontSize: "16px",
                padding: "4px", borderRadius: "4px", display: "flex", alignItems: "center", justifyContent: "center"
            }}>✕</button>
    </div>
    container.appendChild(header)

    const listContainer = <div id="odie-history-list" style={{
        flex: "1", overflowY: "auto", padding: "12px"
    }}></div>
    container.appendChild(listContainer)

    const renderList = (root: HTMLElement) => {
        const groups = chatHistory.getGroupedSessions()

        Object.entries(groups).forEach(([groupName, sessions]) => {
            if (sessions.length === 0) return

            const groupHeader = <div
                role="heading"
                aria-level="3"
                style={{
                    fontSize: "11px", fontWeight: "700", color: "#64748b",
                    textTransform: "uppercase", padding: "12px 8px 4px 8px"
                }}>{groupName}</div>
            root.appendChild(groupHeader)

            sessions.forEach(session => {
                const isConfirming = pendingDeleteId === session.id

                const item = <div className="history-item"
                    role="button"
                    tabIndex={0}
                    style={{
                        padding: "12px 14px", borderRadius: "8px",
                        cursor: "pointer", display: "flex", flexDirection: "column", gap: "4px",
                        transition: "all 0.1s",
                        color: "var(--text-primary)",
                        position: "relative",
                        overflow: "hidden"
                    }}
                    onclick={() => {
                        if (!isConfirming) {
                            service.loadSession(session.id)
                            onClose()
                        }
                    }}>
                    <div style={{ fontSize: "13px", color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {session.title || "Untitled Chat"}
                    </div>
                    <div className="meta-row" style={{ fontSize: "11px", color: "var(--text-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center", height: "20px" }}>
                        <span>{new Date(session.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>

                        <span className="delete-trigger"
                            style={{
                                opacity: isConfirming ? "0" : "0",
                                transition: "opacity 0.2s", fontSize: "14px", cursor: "pointer",
                                padding: "2px 6px", borderRadius: "4px"
                            }}
                            onclick={(e: MouseEvent) => {
                                e.stopPropagation()
                                pendingDeleteId = session.id
                                redraw()
                            }}
                        >🗑</span>
                    </div>

                    {/* Confirmation Overlay - Rendered Conditionally based on State */}
                    <div className="confirm-overlay" style={{
                        display: isConfirming ? "flex" : "none",
                        position: "absolute", top: "0", left: "0", right: "0", bottom: "0",
                        background: "var(--bg-surface-2)",
                        alignItems: "center", justifyContent: "flex-end",
                        padding: "0 12px", gap: "8px",
                        zIndex: "100"
                    }} onclick={(e: MouseEvent) => e.stopPropagation()}>

                        <button className="cancel-action-btn" style={{
                            background: "none", border: "1px solid var(--border-dim)", color: "var(--text-primary)",
                            padding: "4px 10px", borderRadius: "4px", fontSize: "11px", cursor: "pointer",
                            transition: "all 0.1s"
                        }} onclick={(e: MouseEvent) => {
                            e.stopPropagation()
                            pendingDeleteId = null
                            redraw()
                        }}>Cancel</button>

                        <button className="delete-action-btn" style={{
                            background: "var(--color-red)", border: "none", color: "white",
                            padding: "4px 12px", borderRadius: "4px", fontSize: "11px", cursor: "pointer", fontWeight: "600",
                            transition: "all 0.1s"
                        }} onclick={(e: MouseEvent) => {
                            e.stopPropagation()
                            // Clear state first
                            pendingDeleteId = null
                            // The delete action triggers a store update which triggers redraw()
                            // But we also explicitly clear local state just in case
                            setTimeout(() => {
                                chatHistory.deleteSession(session.id)
                            }, 0)
                        }}>Delete</button>
                    </div>

                </div> as HTMLElement

                item.onmouseenter = () => {
                    const trigger = item.querySelector(".delete-trigger") as HTMLElement
                    // Ensure trash icon is visible on hover UNLESS we are confirming delete
                    if (trigger && pendingDeleteId !== session.id) trigger.style.opacity = "0.7"
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

    const binding = chatHistory.sessions.subscribe(() => redraw())

    const cleanupContainer = container as HTMLElement & { cleanup?: () => void }
    cleanupContainer.cleanup = () => binding.terminate()

    return container
}
