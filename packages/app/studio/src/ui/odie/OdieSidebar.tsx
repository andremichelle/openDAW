import { createElement } from "@opendaw/lib-jsx"
import { Terminator } from "@opendaw/lib-std"
import { StudioService } from "@/service/StudioService"
import { Html } from "@opendaw/lib-dom"

// --- CYBERPUNK STYLES ---
import css from "./OdieSidebar.sass?inline"
// ... (imports)
const className = Html.adoptStyleSheet(css, "OdieSidebar")


// --- CLEAN UI ICONS (Standard SVG) ---
const IconProfile = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
    </svg>
)

const IconSchool = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 10v6M2 10l10-5 10 5-10 5z"></path>
        <path d="M6 12v5c3 3 9 3 12 0v-5"></path>
    </svg>
)

const IconSparkles = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
)

const IconHistory = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" />
    </svg>
)

const IconSettings = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
)

const IconExpand = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 3 21 3 21 9"></polyline>
        <polyline points="9 21 3 21 3 15"></polyline>
        <line x1="21" y1="3" x2="14" y2="10"></line>
        <line x1="3" y1="21" x2="10" y2="14"></line>
    </svg>
)

const IconClose = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
    </svg>
)

const RailBtn = (props: { icon: any, label: string, variant: string, onclick: () => void }) => {
    return <button className={`RailBtn ${props.variant}`}
        title={props.label}
        onclick={props.onclick}
    >
        {props.icon}
        <span>{props.label}</span>
    </button>
}

const HeaderAction = (props: { icon: any, title: string, onclick: () => void }) => <button
    className="HeaderAction"
    title={props.title} onclick={props.onclick}
>
    {props.icon}
</button>

export const OdieSidebar = ({ service }: { service: StudioService }) => {
    const lifecycle = new Terminator()
    let odieService: any = null // Lazy loaded

    // History Panel State
    let historyPanel: HTMLElement | null = null

    const toggleExpand = () => {
        if (!odieService) return
        const current = odieService.width.getValue()
        // Toggle between standard (450) and wide (800)
        odieService.setWidth(current > 500 ? 450 : 800)
    }

    const toggleHistory = () => {
        if (!odieService) return
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
                const mainArea = container.firstChild?.firstChild as HTMLElement
                if (mainArea) {
                    mainArea.appendChild(historyPanel)
                    if (getComputedStyle(mainArea).position === "static") {
                        mainArea.style.position = "relative"
                    }
                }
            })
        }
    }

    const renderRail = () => {
        return <div className={className}>
            {/* Top Group: Identity & Knowledge */}
            <RailBtn icon={<IconProfile />} label="Profile" variant="profile" onclick={() => {
                if (!odieService) return
                import("./OdieProfileModal").then(({ OdieProfileModal }) => {
                    const overlay = OdieProfileModal({ onClose: () => overlay.remove() })
                    document.body.appendChild(overlay)
                })
            }} />
            <RailBtn icon={<IconSchool />} label="Academy" variant="academy" onclick={() => {
                if (!odieService) return
                import("./OdieSchoolModal").then(({ OdieSchoolModal }) => {
                    const overlay = OdieSchoolModal({ service: odieService, onClose: () => overlay.remove() })
                    document.body.appendChild(overlay)
                })
            }} />


            <div style={{ flex: "1" }}></div>
            {/* Bottom Group: Session & System */}

            <div className="Separator"></div>

            <RailBtn icon={<IconSparkles />} label="New Chat" variant="newchat" onclick={() => {
                if (odieService) odieService.startNewChat()
            }} />

            <RailBtn icon={<IconHistory />} label="History" variant="history" onclick={toggleHistory} />

            <RailBtn icon={<IconSettings />} label="System" variant="system" onclick={() => {
                if (!odieService) return
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

    const header = <div className="Header">
        {/* Clean Title Area */}
        <div className="title-group">
            <span className="brand">ODIE</span>
            <span className="status">Online</span>
        </div>

        {/* Window Controls Only */}
        <div className="window-controls">
            <HeaderAction
                icon={<IconExpand />}
                title="Expand"
                onclick={toggleExpand}
            />
            <HeaderAction
                icon={<IconClose />}
                title="Close"
                onclick={() => service.layout.odieVisible.setValue(false)}
            />
        </div>
    </div>

    const messageListContainer = <div style={{ flex: "1", display: "flex", flexDirection: "column", overflow: "hidden", padding: "0" }}></div>
    const inputContainer = <div style={{ flexShrink: "0" }}></div>

    const mainArea = <div className="ChatContainer">
        {header}
        {messageListContainer}
        {inputContainer}
    </div>

    // OVERLAY CONTAINER
    const container = <div id="odie-sidebar" className="OdieOverlay">
        {/* THE LOOM HUD - Floating Sidecar */}
        <div className="sidecar-container">
            {/* <OdieGenUIPanel lifecycle={lifecycle} service={odieService} /> */}
        </div>

        <div className="inner-layout">
            <div style={{ display: "flex", flexGrow: "1", overflow: "hidden" }}> {/* Flex wrapper */}
                {mainArea}
            </div>
            {renderRail()}
        </div>
    </div> as HTMLElement


    const initOdie = () => {
        if (odieService) return
        console.log("🤖 Booting Odie lazy...")
        odieService = service.getOdie()

        // Load Children Components
        import("./OdieMessageList").then(({ OdieMessageList }) => {
            const list = OdieMessageList({ service: odieService })
            messageListContainer.appendChild(list)
        })

        import("./OdieInput").then(({ OdieInput }) => {
            const input = OdieInput({ service: odieService })
            inputContainer.appendChild(input)
        })

        // Subscribe to WIDTH changes
        lifecycle.own(odieService.width.subscribe((observer: any) => {
            if (service.layout.odieVisible.getValue()) {
                container.style.width = observer.getValue() + "px"
            }
        }))
    }

    // Toggle Logic
    const updateVisibility = (visible: boolean) => {
        if (visible) {
            initOdie()
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

    lifecycle.own(service.layout.odieVisible.subscribe((observer: any) => updateVisibility(observer.getValue())))

    // Initial check
    if (service.layout.odieVisible.getValue()) {
        updateVisibility(true)
    }

    return container
}
