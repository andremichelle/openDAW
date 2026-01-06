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


    // --- STATUS BAR ELEMENTS ---
    const statusDot = <div className="status-dot"></div> as HTMLElement
    const providerLabel = <span className="provider-label">GEMINI</span> as HTMLElement
    const activityLabel = <span className="activity-label">Ready</span> as HTMLElement


    // --- LIFECYCLE & SUBSCRIPTIONS ---
    const lifecycle = new Terminator()

    // 1. Activity Monitor
    const updateStatus = (isThinking: boolean) => {
        statusDot.classList.toggle("thinking", isThinking)
        statusDot.classList.toggle("connected", !isThinking)
    }

    // Initialize State Immediately (Crucial for "Connected on Load")
    updateStatus(service.isGenerating.getValue())

    lifecycle.own(service.isGenerating.subscribe(obs => {
        updateStatus(obs.getValue())
    }))

    // 2. Activity Detail Monitor
    lifecycle.own(service.activityStatus.subscribe(obs => {
        const status = obs.getValue()
        activityLabel.innerText = status
        activityLabel.classList.toggle("active", status !== "Ready")
    }))

    // 3. Provider/Model Monitor
    lifecycle.own(service.activeModelName.subscribe(obs => {
        let name = obs.getValue()
        if (name.includes("gemini-3-flash")) name = "Gemini • 3 Flash"
        else if (name.includes("gemini-2.5-flash-image")) name = "Gemini • Nano Banana"
        providerLabel.innerText = name.toUpperCase()
    }))

    // 4. Focus Monitor
    lifecycle.own(service.visible.subscribe(visible => {
        if (visible) {
            // Trigger Boot Animation
            statusDot.classList.add("booting")
            setTimeout(() => {
                statusDot.classList.remove("booting")
                // Double-check state to ensure we land on the correct color
                updateStatus(service.isGenerating.getValue())
            }, 600)

            setTimeout(() => {
                if (document.body.contains(textarea)) textarea.focus()
            }, 50)
        }
    }))

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

