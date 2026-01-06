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
    const container = <div style={{
        position: "absolute",
        top: "0", left: "0", bottom: "0",
        width: "280px",
        background: "rgba(15, 23, 42, 0.95)",
        backdropFilter: "blur(10px)",
        borderRight: "1px solid rgba(255,255,255,0.1)",
        zIndex: "200",
        display: "flex", flexDirection: "column",
        animation: "slideInLeft 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
        boxShadow: "4px 0 20px rgba(0,0,0,0.5)"
    }}>
        <style>{`
            @keyframes slideInLeft { from { transform: translateX(-20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            .history-item:hover { background: rgba(255,255,255,0.05); }
        `}</style>
    </div> as HTMLElement

    // Header
    const header = <div style={{
        padding: "20px",
        borderBottom: "1px solid rgba(255,255,255,0.1)",
        display: "flex", justifyContent: "space-between", alignItems: "center"
    }}>
        <div style={{ fontWeight: "700", fontSize: "16px", color: "#f1f5f9" }}>History</div>
        <button onclick={onClose} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "18px" }}>✕</button>
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
                        padding: "10px 8px", borderRadius: "8px",
                        cursor: "pointer", display: "flex", flexDirection: "column", gap: "4px",
                        transition: "background 0.1s"
                    }}
                        onclick={() => {
                            service.loadSession(session.id)
                            onClose() // Close panel on selection? Or keep open? Let's close for now.
                        }}>
                        <div style={{ fontSize: "13px", color: "#e2e8f0", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {session.title || "Untitled Chat"}
                        </div>
                        <div style={{ fontSize: "11px", color: "#64748b", display: "flex", justifyContent: "space-between" }}>
                            <span>{new Date(session.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                            <span
                                style={{ color: "#ef4444", opacity: "0", transition: "opacity 0.2s", fontSize: "12px", cursor: "pointer" }}
                                onclick={(e: any) => {
                                    e.stopPropagation()
                                    const target = e.target as HTMLElement
                                    // Switch to confirm mode
                                    if (target.innerText === "🗑") {
                                        target.innerText = "Sure? Delete"
                                        target.style.opacity = "1"
                                        target.style.color = "#f87171"

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
    // @ts-ignore
    container.cleanup = () => binding.terminate()

    return container
}
