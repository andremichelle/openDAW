import { createElement } from "@opendaw/lib-jsx"
import { Terminator } from "@opendaw/lib-std"
import { OdieService } from "./OdieService"
import { Html } from "@opendaw/lib-dom"

// --- STYLES ---
import css from "./OdieInput.sass?inline"
const className = Html.adoptStyleSheet(css, "OdieInput")

interface inputProps {
    service: OdieService
}

const CockpitButton = ({ icon, label, onClick, pulse = false, id }: any) => {
    return <button
        className={`CockpitButton ${pulse ? 'pulse' : ''}`}
        id={id}
        title={label}
        onclick={(e: Event) => {
            e.preventDefault()
            e.stopPropagation()
            onClick(e)
        }}
    >
        {icon}
    </button>
}

export const OdieInput = ({ service }: inputProps) => {
    const onSend = (text: string) => {
        service.sendMessage(text)
    }

    const textarea = <textarea
        className="InputArea"
        placeholder="Message Odie..."
    /> as HTMLTextAreaElement

    const adjustHeight = () => {
        textarea.style.height = 'auto'
        textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px'
    }

    textarea.oninput = adjustHeight

    textarea.onkeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            const text = textarea.value.trim()
            if (text) {
                onSend(text)
                textarea.value = ''
                adjustHeight()
            }
        }
    }

    // Auto-focus on mount
    setTimeout(() => { if (document.body.contains(textarea)) textarea.focus() }, 100)


    // ==========================================
    // STATUS BAR (REBUILT - KISS PRINCIPLE)
    // One function. One call. One result.
    // ==========================================

    const statusDot = <div className="status-dot"></div> as HTMLElement
    const providerLabel = <span className="provider-label">...</span> as HTMLElement
    const activityLabel = <span className="activity-label">...</span> as HTMLElement

    // Single function to update indicator (pure, no side effects)
    const setIndicator = (state: "checking" | "connected" | "disconnected" | "thinking", label: string) => {
        statusDot.className = "status-dot " + state
        activityLabel.innerText = label
        activityLabel.classList.toggle("active", state !== "connected")
    }

    // Get display name for provider (with model name for Ollama)
    const getProviderDisplayName = (providerId: string): string => {
        if (providerId === "ollama") {
            const config = service.ai.getConfig("ollama")
            const modelId = config?.modelId
            if (modelId) {
                // Format: "LOCAL: qwen3:30b" → cleaner display
                return `LOCAL: ${modelId.toUpperCase()}`
            }
            return "LOCAL"
        }
        if (providerId === "gemini-3") return "GEMINI 3"
        if (providerId === "gemini") return "GEMINI"
        return providerId.toUpperCase()
    }

    // THE CORE FUNCTION: Check provider and validate connection
    const refreshStatus = async () => {
        const providerId = service.ai.activeProviderId.getValue()
        const provider = service.ai.getActiveProvider()

        // Update provider name immediately
        providerLabel.innerText = getProviderDisplayName(providerId)

        // Show checking state
        setIndicator("checking", "Checking...")

        if (!provider) {
            setIndicator("disconnected", "No Provider")
            return
        }

        // Validate the connection
        if (typeof provider.validate === "function") {
            try {
                const result = await provider.validate()
                console.log(`🔍 [Status] ${providerId}: ${result.ok ? "✅" : "❌"} ${result.message}`)
                setIndicator(
                    result.ok ? "connected" : "disconnected",
                    result.ok ? "Ready" : "No API"
                )
            } catch (e) {
                console.error(`🔍 [Status] ${providerId}: Error`, e)
                setIndicator("disconnected", "Error")
            }
        } else {
            // No validation available - assume connected
            console.log(`🔍 [Status] ${providerId}: No validate method, assuming connected`)
            setIndicator("connected", "Ready")
        }
    }

    // --- LIFECYCLE (MINIMAL) ---
    const lifecycle = new Terminator()

    // 1. Thinking state (during generation)
    lifecycle.own(service.isGenerating.subscribe(obs => {
        if (obs.getValue()) {
            setIndicator("thinking", "Thinking...")
        } else {
            // After generation completes, re-check connection
            refreshStatus()
        }
    }))

    // 2. Provider change → re-validate
    lifecycle.own(service.ai.activeProviderId.subscribe(() => {
        refreshStatus()
    }))

    // 3. Panel open → initial check
    lifecycle.own(service.visible.subscribe(visible => {
        if (visible) {
            refreshStatus()
            setTimeout(() => {
                if (document.body.contains(textarea)) textarea.focus()
            }, 50)
        }
    }))

    // Initial state (sync, before any async)
    providerLabel.innerText = getProviderDisplayName(service.ai.activeProviderId.getValue())
    setIndicator("checking", "...")

    // Trigger initial validation
    refreshStatus()


    // -- Container --
    const container = <div className={className}>
        {/* Panel */}
        <div className="InputPanel">

            {/* 1. Text Input Row */}
            <div style={{ display: "flex", width: "100%" }}>
                {textarea}
            </div>

            {/* 2. Actions Row */}
            <div className="ActionsRow">

                {/* Left: Tools */}
                <div className="ToolsGroup">
                    {/* Attach */}
                    {(() => {
                        const fileInput = <input
                            type="file"
                            accept=".txt,.md,.json,.csv"
                            style={{ display: "none" }}
                            onchange={(e: Event) => {
                                const input = e.target as HTMLInputElement
                                const file = input.files?.[0]
                                if (file) {
                                    const reader = new FileReader()
                                    reader.onload = () => {
                                        const content = reader.result as string
                                        const preview = content.slice(0, 500) + (content.length > 500 ? '...' : '')
                                        textarea.value = `[Attached: ${file.name}]\n\n${preview}\n\n---\nDescribe what you want to do with this file:`
                                        adjustHeight()
                                        textarea.focus()
                                    }
                                    reader.readAsText(file)
                                }
                                input.value = '' // Reset
                            }}
                        /> as HTMLInputElement

                        return <CockpitButton
                            icon="📎"
                            label="Attach File"
                            onClick={() => fileInput.click()}
                        />
                    })()}
                </div>

                {/* Center: Status Bar */}
                <div className="StatusBar">
                    {statusDot}
                    {providerLabel}
                    <div className="separator"></div>
                    {activityLabel}
                </div>


                {/* Right: Send */}
                <button
                    className="SendButton"
                    onclick={(e: Event) => {
                        e.preventDefault()
                        const text = textarea.value.trim()
                        if (text) { onSend(text); textarea.value = ''; adjustHeight(); }
                    }}
                >
                    ➤
                </button>

            </div>
        </div>
    </div> as HTMLElement

    return container
}

