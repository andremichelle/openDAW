import { createElement } from "@opendaw/lib-jsx"
import { Terminator } from "@opendaw/lib-std"
import { StudioService } from "@/service/StudioService"
// [ANTIGRAVITY] Cleaned Up Unused Imports

// --- CYBERPUNK STYLES ---
const S = {
    rail: {
        width: "72px",
        background: "#050505",
        borderLeft: "1px solid rgba(255,255,255,0.08)",
        display: "flex", flexDirection: "column",
        alignItems: "center", padding: "20px 0",
        gap: "24px",
        zIndex: "20",
        transition: "width 0.3s ease"
    },
    railBtn: {
        width: "60px", height: "56px",
        borderRadius: "12px",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        color: "#64748b",
        cursor: "pointer",
        transition: "all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)",
        background: "transparent", border: "1px solid transparent",
        position: "relative",
        zIndex: "20",
        gap: "4px"
    },
    railBtnHover: {
        color: "#e2e8f0",
        background: "rgba(255,255,255,0.06)",
        borderColor: "rgba(255,255,255,0.1)",
        boxShadow: "0 0 20px rgba(59, 130, 246, 0.15)",
        transform: "scale(1.05)"
    },
    railLabel: {
        fontSize: "9px",
        fontWeight: "700",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
        textAlign: "center",
        opacity: "0.8"
    },
    separator: {
        width: "20px", height: "1px", background: "rgba(255,255,255,0.1)"
    },
    chatContainer: {
        flex: "1", display: "flex", flexDirection: "column",
        background: "var(--color-panel-background-bright)", // Keep high contrast
        position: "relative", overflow: "hidden"
    },
    header: {
        height: "56px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 20px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        background: "rgba(10,10,10,0.8)", backdropFilter: "blur(10px)"
    },
    // Glowing Indicator Style
    indicator: {
        width: "8px", height: "8px", borderRadius: "50%",
        boxShadow: "0 0 10px currentColor, 0 0 5px currentColor",
        transition: "all 0.5s ease"
    }
}

// --- ICONS (NEON SVG) ---
const IconProfile = ({ color }: { color: string }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style={{ width: "24px", height: "24px", filter: `drop-shadow(0 0 4px ${color})` }}>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
    </svg>
)

const IconSchool = ({ color }: { color: string }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style={{ width: "24px", height: "24px", filter: `drop-shadow(0 0 4px ${color})` }}>
        <path d="M22 10v6M2 10l10-5 10 5-10 5z"></path>
        <path d="M6 12v5c3 3 9 3 12 0v-5"></path>
    </svg>
)



const IconSparkles = ({ color }: { color: string }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style={{ width: "24px", height: "24px", filter: `drop-shadow(0 0 4px ${color})` }}>
        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
)

const IconHistory = ({ color }: { color: string }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style={{ width: "24px", height: "24px", filter: `drop-shadow(0 0 4px ${color})` }}>
        <path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" />
    </svg>
)

const IconSettings = ({ color }: { color: string }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style={{ width: "24px", height: "24px", filter: `drop-shadow(0 0 2px ${color})` }}>
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
)

const IconExpand = ({ color }: { color: string }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ width: "16px", height: "16px", filter: `drop-shadow(0 0 3px ${color})` }}>
        <polyline points="15 3 21 3 21 9"></polyline>
        <polyline points="9 21 3 21 3 15"></polyline>
        <line x1="21" y1="3" x2="14" y2="10"></line>
        <line x1="3" y1="21" x2="10" y2="14"></line>
    </svg>
)

const IconClose = ({ color }: { color: string }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ width: "16px", height: "16px", filter: `drop-shadow(0 0 3px ${color})` }}>
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
    </svg>
)

const RailBtn = (props: { icon: any, label: string, color?: string, onclick: () => void }) => {
    return <div style={S.railBtn}
        title={props.label}
        onclick={props.onclick}
        onmouseenter={(e: any) => {
            const target = e.currentTarget
            Object.assign(target.style, S.railBtnHover)
            if (props.color) {
                target.style.borderColor = `${props.color}40`
                target.style.boxShadow = `0 0 15px ${props.color}30`
                target.style.background = `rgba(255,255,255,0.05)`
                const labelSpan = target.querySelector('span')
                if (labelSpan) labelSpan.style.color = props.color
            }
        }}
        onmouseleave={(e: any) => {
            const target = e.currentTarget
            target.style.color = "#64748b"
            target.style.background = "transparent"
            target.style.boxShadow = "none"
            target.style.borderColor = "transparent"
            target.style.transform = "scale(1)"
            const labelSpan = target.querySelector('span')
            if (labelSpan) labelSpan.style.color = "inherit"
        }}
    >
        {props.icon}
        <span style={S.railLabel}>{props.label}</span>
    </div>
}

const HeaderAction = (props: { icon: any, title: string, onclick: () => void }) => <button
    title={props.title} onclick={props.onclick}
    style={{
        background: "transparent", border: "none", color: "#94a3b8",
        cursor: "pointer", padding: "8px", borderRadius: "6px",
        fontSize: "14px", display: "flex", alignItems: "center", justifyContent: "center",
        transition: "all 0.2s"
    }}
    onmouseenter={(e: any) => { e.target.style.color = "white"; e.target.style.background = "rgba(255,255,255,0.05)" }}
    onmouseleave={(e: any) => { e.target.style.color = "#94a3b8"; e.target.style.background = "transparent" }}
>
    {props.icon}
</button>

export const OdieSidebar = ({ service }: { service: StudioService }) => {
    const lifecycle = new Terminator()
    const odieService = service.odieService


    // History Panel State
    let historyPanel: HTMLElement | null = null

    const toggleExpand = () => {
        const current = odieService.width.getValue()
        // Toggle between standard (450) and wide (800)
        odieService.setWidth(current > 500 ? 450 : 800)
    }

    const toggleHistory = () => {
        if (historyPanel) {
            historyPanel.remove()
            historyPanel = null
        } else {
            import("./OdieHistoryPanel").then(({ OdieHistoryPanel }) => {
                historyPanel = OdieHistoryPanel({
                    service: odieService,
                    onClose: () => {
                        if (historyPanel) {
                            historyPanel.remove()
                            historyPanel = null
                        }
                    }
                })
                // Find main area (chat context) roughly by class or just append to container.
                // The container has flex row: [MainArea] [Rail] (Swapped). 
                // We want it INSIDE MainArea, which is the 1st child of container.firstChild
                // Let's try to query it or just append to container.firstChild (mainArea wrapper)
                const mainArea = container.firstChild?.firstChild as HTMLElement
                if (mainArea) {
                    mainArea.appendChild(historyPanel)
                    // Ensure relative positioning on mainArea so absolute child works
                    if (getComputedStyle(mainArea).position === "static") {
                        mainArea.style.position = "relative"
                    }
                }
            })
        }
    }

    const renderRail = () => {
        return <div style={S.rail}>
            {/* Top Group: Identity & Knowledge */}
            <RailBtn icon={<IconProfile color="#a855f7" />} label="Profile" color="#a855f7" onclick={() => {
                import("./OdieProfileModal").then(({ OdieProfileModal }) => {
                    const overlay = OdieProfileModal({ onClose: () => overlay.remove() })
                    document.body.appendChild(overlay)
                })
            }} />
            <RailBtn icon={<IconSchool color="#f472b6" />} label="Academy" color="#f472b6" onclick={() => {
                import("./OdieSchoolModal").then(({ OdieSchoolModal }) => {
                    const overlay = OdieSchoolModal({ service: odieService, onClose: () => overlay.remove() })
                    document.body.appendChild(overlay)
                })
            }} />


            <div style={{ flex: "1" }}></div>
            {/* Bottom Group: Session & System */}

            <div style={S.separator}></div>

            <RailBtn icon={<IconSparkles color="#22c55e" />} label="New Chat" color="#22c55e" onclick={() => {
                odieService.startNewChat()
            }} />

            <RailBtn icon={<IconHistory color="#eab308" />} label="History" color="#eab308" onclick={toggleHistory} />

            <RailBtn icon={<IconSettings color="#64748b" />} label="System" color="#64748b" onclick={() => {
                import("./components/OdieModalFrame").then(({ OdieModalFrame }) => {
                    import("./OdieSettings").then(({ OdieSettings }) => {
                        let overlay: HTMLElement
                        const close = () => overlay.remove()
                        const settingsContent = OdieSettings({ service: odieService, onBack: close, isEmbedded: false })
                        overlay = OdieModalFrame({ title: "System Config", icon: "⚙️", width: "800px", onClose: close, children: settingsContent })
                        document.body.appendChild(overlay)
                    })
                })
            }} />
        </div>
    }

    const header = <div style={S.header}>
        {/* Minimalist Title Area */}
        <div style={{ display: "flex", alignItems: "baseline", gap: "12px", fontFamily: "'Orbitron', sans-serif" }}>
            <span style={{
                fontSize: "22px",
                fontWeight: "800",
                letterSpacing: "4px",
                color: "#e0f2fe",
                textTransform: "uppercase",
                textShadow: "0 0 5px #38bdf8, 0 0 10px #0ea5e9, 0 0 20px #0284c7"
            }}>
                ODIE
            </span>
            <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                <span style={{
                    fontSize: "12px",
                    fontWeight: "600",
                    letterSpacing: "1px",
                    color: "#94a3b8", // Neutral slate
                    textTransform: "lowercase",
                    textShadow: "none"
                }}>
                    is
                </span>
                <span style={{
                    fontSize: "12px",
                    fontWeight: "800",
                    letterSpacing: "1px",
                    color: "#4ade80",
                    textTransform: "none", // Case sensitive as requested
                    textShadow: "0 0 5px #4ade80, 0 0 10px #22c55e"
                }}>
                    Online
                </span>
            </div>
        </div>

        {/* Window Controls Only */}
        <div style={{ display: "flex", gap: "4px" }}>
            <HeaderAction
                icon={<IconExpand color="#e0f2fe" />}
                title="Expand"
                onclick={toggleExpand}
            />
            <HeaderAction
                icon={<IconClose color="#e0f2fe" />}
                title="Close"
                onclick={() => odieService.visible.setValue(false)}
            />
        </div>
    </div>

    const messageListContainer = <div style={{ flex: "1", display: "flex", flexDirection: "column", overflow: "hidden", padding: "0" }}></div>

    // Lazy load the message list
    import("./OdieMessageList").then(({ OdieMessageList }) => {
        const list = OdieMessageList({ service: odieService })
        messageListContainer.appendChild(list)
    })

    // Lazy load input
    const inputContainer = <div style={{ flexShrink: "0" }}></div>
    import("./OdieInput").then(({ OdieInput }) => {
        const input = OdieInput({ service: odieService })
        inputContainer.appendChild(input)
    })

    const mainArea = <div style={S.chatContainer}>
        {header}
        {messageListContainer}
        {inputContainer}
    </div>

    // OVERLAY CONTAINER
    const container = <div id="odie-sidebar" style={{
        position: "absolute",
        top: "48px", right: "0", bottom: "0",
        width: "0px",
        display: "none",
        background: "black", color: "white", fontFamily: "Inter, sans-serif",
        boxShadow: "-4px 0 20px rgba(59, 130, 246, 0.2), -1px 0 0 rgba(59, 130, 246, 0.4)", // Blue Glow
        borderLeft: "1px solid rgba(59, 130, 246, 0.2)",
        zIndex: "2000",
        transition: "width 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        overflow: "visible" // Ensure Sidecar can protrude
    }}>
        {/* THE LOOM HUD - Floating Sidecar */}
        <div style={{
            position: "absolute",
            right: "100%",
            bottom: "20px",
            marginRight: "12px", // Spacing from sidebar
            zIndex: "2001",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end", // Align to the sidebar edge
            pointerEvents: "auto" // Ensure interactable
        }}>
            {/* <OdieGenUIPanel lifecycle={lifecycle} service={odieService} /> */}
        </div>

        <div style={{ width: "100%", height: "100%", display: "flex", overflow: "hidden", position: "relative" }}>

            <div style={{ display: "flex", flexGrow: "1", overflow: "hidden" }}> {/* Flex wrapper */}
                {mainArea}
            </div>
            {renderRail()}
        </div>
    </div> as HTMLElement

    // Toggle Logic
    const updateVisibility = (visible: boolean) => {
        if (visible) {
            container.style.display = "block"
            requestAnimationFrame(() => {
                const w = odieService.width.getValue()
                container.style.width = w + "px"
            })
        } else {
            container.style.width = "0px"
            setTimeout(() => {
                if (container.style.width === "0px") container.style.display = "none"
            }, 300)
        }
    }

    lifecycle.own(odieService.visible.subscribe((observer: any) => updateVisibility(observer.getValue())))

    // Subscribe to WIDTH changes too!
    lifecycle.own(odieService.width.subscribe((observer: any) => {
        if (odieService.visible.getValue()) {
            container.style.width = observer.getValue() + "px"
        }
    }))

    // Initial check
    if (odieService.visible.getValue()) {
        container.style.display = "block"
        container.style.width = odieService.width.getValue() + "px"
    }

    return container
}
