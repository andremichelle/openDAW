import { createElement } from "@opendaw/lib-jsx"
import { Terminator } from "@opendaw/lib-std"
import { StudioService } from "@/service/StudioService"
import { Html } from "@opendaw/lib-dom"
import { OdieService } from "./OdieService"
import { OdieProfileModal } from "./OdieProfileModal"

// --- STYLES ---
import css from "./OdieSidebar.sass?inline"
const className = Html.adoptStyleSheet(css, "OdieSidebar")


// --- CLEAN UI ICONS (Standard SVG) ---
const IconProfile = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
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

const RailBtn = (props: { icon: any, label: string, variant: string, onclick?: () => void }) => {
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


export const OdieSidebar = (props: { service: StudioService, lifecycle: Terminator }) => {
    const { service, lifecycle } = props
    let odieService: OdieService | undefined

    // -- VIEW CONTAINERS --
    // We keep Chat view persistent to maintain scroll/input state
    const chatView = <div className="ChatContainer" style={{ display: "flex", flex: "1", flexDirection: "column", overflow: "hidden" }}></div>
    const historyView = <div className="HistoryContainer" style={{ display: "none", flex: "1", flexDirection: "column", overflow: "hidden" }}></div>

    // -- RAIL BUTTONS --
    const renderRail = () => (<div className="OdieRail">
        {/* Top Group: Identity & Knowledge */}
        <RailBtn icon={<IconProfile />} label="Profile" variant="profile" onclick={() => {
            if (!odieService) return
            const modal = OdieProfileModal({ onClose: () => modal.remove() })
            document.body.appendChild(modal)
        }} />

        <div style={{ flex: "1" }}></div>

        <div className="Separator"></div>

        <RailBtn icon={<IconSparkles />} label="New Chat" variant="newchat" onclick={() => {
            if (odieService) odieService.startNewChat()
        }} />

        <RailBtn icon={<IconHistory />} label="History" variant="history" onclick={() => {
            if (!odieService) return
            // Toggle Logic handled by subscription below, we just flip the state
            odieService.showHistory.setValue(!odieService.showHistory.getValue())
        }} />

        <RailBtn icon={<IconSettings />} label="Settings" variant="settings" onclick={() => {
            // Helper handles the logic, or we can drive via state
            if (odieService) odieService.viewState.setValue("settings")
        }} />
    </div>);

    const header = <div className="Header">
        {/* Clean Title Area */}
        <div className="title-group">
            <span className="brand">Odie</span>
            <span className="status">Ready</span>
        </div>

        {/* Window Controls Only */}
        <div className="window-controls">
            <HeaderAction
                icon={<IconExpand />}
                title="Expand"
                onclick={() => {
                    if (odieService) {
                        const current = odieService.width.getValue()
                        odieService.setWidth(current > 500 ? 450 : 800)
                    }
                }}
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

    // Assemble Chat View
    chatView.appendChild(header)
    chatView.appendChild(messageListContainer)
    chatView.appendChild(inputContainer)

    const container = <div id="odie-sidebar" className={`${className} OdieOverlay`}>
        <div className="sidecar-container">
        </div>

        <div className="inner-layout">
            <div style={{ display: "flex", flexGrow: "1", overflow: "hidden", position: "relative" }}> {/* Flex wrapper */}
                {chatView}
                {historyView}

                {/* Settings Overlay Removed */}
                {/* We are now initiating settings via the button directly */}
            </div>
            {renderRail()}
        </div>
    </div> as HTMLElement


    const initOdie = () => {
        if (odieService) return
        odieService = service.getOdie()

        // Load Children Components (Parallel Boot)
        Promise.all([
            import("./OdieMessageList"),
            import("./OdieInput"),
            import("./OdieHistoryPanel")
        ]).then(([{ OdieMessageList }, { OdieInput }, { OdieHistoryPanel }]) => {
            if (!odieService) return

            // 1. Mount Chat
            const list = OdieMessageList({ service: odieService })
            messageListContainer.appendChild(list)

            const input = OdieInput({ service: odieService })
            inputContainer.appendChild(input)

            // 2. Mount History (Persistently mounted but hidden)
            const historyPanel = OdieHistoryPanel({
                service: odieService,
                onClose: () => odieService?.showHistory.setValue(false)
            })
            historyView.appendChild(historyPanel)
        })

        // Subscribe to WIDTH changes
        lifecycle.own(odieService.width.subscribe((observer: any) => {
            if (service.layout.odieVisible.getValue()) {
                container.style.width = observer.getValue() + "px"
            }
        }))

        // Subscribe to History Toggle (Synchronous & Safe)
        lifecycle.own(odieService.showHistory.subscribe((observer: any) => {
            const show = observer.getValue()
            if (show) {
                chatView.style.display = "none"
                historyView.style.display = "flex"
            } else {
                chatView.style.display = "flex"
                historyView.style.display = "none"
            }
        }))

        // [ANTIGRAVITY] Subscribe to View State (Settings / Chat)
        lifecycle.own(odieService.viewState.subscribe((observer: any) => {
            const state = observer.getValue()
            if (state === "settings") {
                openSettingsModal()
            }
        }))
    }

    // Helper: Open Settings Modal
    const openSettingsModal = () => {
        if (!odieService) return

        // Prevent double-opening if already active? 
        // Simple check: exists in DOM? 
        if (document.getElementById("odie-settings-overlay")) return

        import("./components/OdieModalFrame").then(({ OdieModalFrame }) => {
            import("./OdieSettings").then(({ OdieSettings }) => {
                let overlay: HTMLElement
                const modalLifecycle = new Terminator()

                const close = () => {
                    overlay.remove()
                    modalLifecycle.terminate()
                    // Sync state back to chat if we closed it manually
                    if (odieService?.viewState.getValue() === "settings") {
                        odieService?.viewState.setValue("chat")
                    }
                }

                const settingsContent = OdieSettings({ service: odieService!, lifecycle: modalLifecycle, onBack: close, isEmbedded: false })
                overlay = OdieModalFrame({
                    title: "Settings",
                    icon: "⚙️",
                    width: "1100px",
                    onClose: close,
                    children: settingsContent
                })
                overlay.id = "odie-settings-overlay" // Marker for singleton check
                document.body.appendChild(overlay)
            })
        })
    }

    // Toggle Logic
    const updateVisibility = (visible: boolean) => {
        if (visible) {
            initOdie()
            container.style.display = "block"
            requestAnimationFrame(() => {
                if (!odieService) return
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

