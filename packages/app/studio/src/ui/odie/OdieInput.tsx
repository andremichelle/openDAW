import { createElement } from "@opendaw/lib-jsx"
import { Terminator } from "@opendaw/lib-std" // Added Terminator
import { OdieService } from "./OdieService"


interface inputProps {
    service: OdieService
}

// -- Helper: Action Button --
const CockpitButton = ({ icon, label, onClick, color = "#94a3b8", pulse = false, id }: any) => {
    // Styling
    const style = {
        background: "transparent",
        border: "none",
        cursor: "pointer",
        color: color,
        fontSize: "18px",
        padding: "8px",
        borderRadius: "50%",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "all 0.2s ease",
        position: "relative",
        opacity: "0.8"
    }

    // JSX Binding
    const btn = <button
        id={id}
        style={style}
        title={label}
        onclick={(e: Event) => {
            e.preventDefault()
            e.stopPropagation()
            console.log(`[OdieInput] Clicked: ${label}`)
            onClick(e)
        }}
        onmouseenter={(e: Event) => {
            (e.target as HTMLElement).style.background = "rgba(255,255,255,0.1)";
            (e.target as HTMLElement).style.transform = "scale(1.1)";
            (e.target as HTMLElement).style.opacity = "1";
        }}
        onmouseleave={(e: Event) => {
            (e.target as HTMLElement).style.background = "transparent";
            (e.target as HTMLElement).style.transform = "scale(1)";
            (e.target as HTMLElement).style.opacity = "0.8";
        }}
    >
        {icon}
    </button> as HTMLElement

    if (pulse) {
        btn.style.animation = "pulse 1.5s infinite"
        // Ensure keyframes exist (idempotent check would be better, but this is fine)
        if (!document.getElementById("pulse-anim")) {
            const s = document.createElement('style')
            s.id = "pulse-anim"
            // Red pulse for recording, Blue/Cyan for thinking?
            s.innerHTML = `@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(59, 130, 246, 0); } 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0); } }`
            document.head.appendChild(s)
        }
    }

    return btn
}

export const OdieInput = ({ service }: inputProps) => {
    const onSend = (text: string) => {
        console.log("[OdieInput] Sending:", text)
        service.sendMessage(text)
    }

    const textarea = <textarea
        placeholder="Message Odie..."
        style={{
            flex: "1",
            minHeight: "24px",
            maxHeight: "150px",
            padding: "8px 12px",
            background: "transparent",
            border: "none",
            color: "#f8fafc",
            resize: "none",
            fontFamily: "inherit",
            fontSize: "15px",
            outline: "none",
            lineHeight: "1.5",
            overflowY: "auto"
        }}
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
    const statusDot = <div style={{
        width: "8px", height: "8px",
        borderRadius: "50%",
        background: "#10b981", // Emerald 500 (Connected)
        boxShadow: "0 0 8px #10b981",
        transition: "all 0.3s ease"
    }}></div> as HTMLElement

    const providerLabel = <span style={{
        fontSize: "11px",
        color: "#94a3b8",
        fontWeight: "500",
        letterSpacing: "0.5px",
        textTransform: "uppercase"
    }}>GEMINI</span> as HTMLElement

    const activityLabel = <span style={{
        fontSize: "11px",
        color: "#64748b",
        fontStyle: "italic",
        transition: "all 0.3s ease"
    }}>Ready</span> as HTMLElement


    // --- LIFECYCLE & SUBSCRIPTIONS ---
    const lifecycle = new Terminator()

    /* [ANTIGRAVITY] Voice Control Disabled for v1.0
    // 1. Activity Monitor (Think Pulse)
    lifecycle.own(service.isListeninig.subscribe...) 
    */
    // 1. Activity Monitor (Think Pulse)
    lifecycle.own(service.isGenerating.subscribe(obs => {
        const isThinking = obs.getValue()

        if (isThinking) {
            statusDot.style.background = "#3b82f6"
            statusDot.style.boxShadow = "0 0 12px #3b82f6"
            statusDot.style.animation = "pulse 1s infinite"
        } else {
            statusDot.style.background = "#10b981" // Green
            statusDot.style.boxShadow = "0 0 8px #10b981"
            statusDot.style.animation = "none"
        }
    }))

    // 2. Activity Detail Monitor (Text)
    lifecycle.own(service.activityStatus.subscribe(obs => {
        const status = obs.getValue()
        activityLabel.innerText = status

        if (status !== "Ready") {
            activityLabel.style.color = "#3b82f6" // Blue
            activityLabel.style.fontWeight = "600" // Bold when active
        } else {
            activityLabel.style.color = "#64748b" // Slate
            activityLabel.style.fontWeight = "400"
        }
    }))

    // 3. Provider/Model Monitor (Dynamic Label)
    lifecycle.own(service.activeModelName.subscribe(obs => {
        // Shorten long model names for UI
        let name = obs.getValue()
        if (name.includes("gemini-3-flash")) name = "Gemini • 3 Flash"
        else if (name.includes("gemini-2.5-flash-image")) name = "Gemini • Nano Banana"
        // else keep as is (e.g. "Gemini")

        providerLabel.innerText = name.toUpperCase()
    }))


    // 4. Focus Monitor (Auto-Focus when Opened)
    lifecycle.own(service.visible.subscribe(visible => {
        if (visible) {
            console.log("[OdieInput] Visibility changed to TRUE. Focusing...")
            // Small timeout to allow transition/rendering
            setTimeout(() => {
                if (document.body.contains(textarea)) {
                    textarea.focus()
                }
            }, 50)
        }
    }))

    // -- Cockpit Container --
    const container = <div style={{
        padding: "16px",
        background: "linear-gradient(to bottom, rgba(15, 23, 42, 0) 0%, rgba(15, 23, 42, 1) 40%)", // Fade in background
        display: "flex",
        justifyContent: "center",
        position: "relative",
        zIndex: "100" // Ensure on top
    }}>
        {/* Glassmorphism Panel */}
        <div style={{
            display: "flex",
            flexDirection: "column", // Stack vertically
            width: "100%",
            maxWidth: "800px",
            background: "rgba(30, 41, 59, 0.8)", // bg-slate-800 / 70%
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderRadius: "24px",
            padding: "12px 16px", // More padding for breathing room
            boxShadow: "0 4px 20px rgba(0, 0, 0, 0.4)",
            gap: "8px"
        }}>

            {/* 1. Text Input Row */}
            <div style={{ display: "flex", width: "100%" }}>
                {textarea}
            </div>

            {/* 2. Actions Row */}
            <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderTop: "1px solid rgba(255,255,255,0.05)",
                paddingTop: "8px",
                marginTop: "4px"
            }}>

                {/* Left: Tools */}
                <div style={{ display: "flex", gap: "8px" }}>
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
                                input.value = '' // Reset for re-selection
                            }}
                        /> as HTMLInputElement

                        return <CockpitButton
                            icon="📎"
                            label="Attach File"
                            onClick={() => fileInput.click()}
                        />
                    })()}
                </div>

                {/* Center: Status Bar (New) */}
                <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    background: "rgba(0,0,0,0.2)",
                    padding: "4px 12px",
                    borderRadius: "12px",
                    border: "1px solid rgba(255,255,255,0.05)"
                }}>
                    {/* [ANTIGRAVITY] Voice Disabled v1.0
                    <CockpitButton icon="🎙️" label="Voice" onClick={() => service.toggleVoice()} />
                    */}
                    {statusDot}
                    {providerLabel}
                    <div style={{ width: "1px", height: "12px", background: "rgba(255,255,255,0.1)" }}></div>
                    {activityLabel}
                </div>


                {/* Right: Send */}
                <button
                    onclick={(e: Event) => {
                        e.preventDefault()
                        const text = textarea.value.trim()
                        if (text) { onSend(text); textarea.value = ''; adjustHeight(); }
                    }}
                    onmouseenter={(e: any) => e.target.style.transform = "scale(1.1)"}
                    onmouseleave={(e: any) => e.target.style.transform = "scale(1)"}
                    style={{
                        background: "#3b82f6", // blue-500
                        border: "none",
                        borderRadius: "50%",
                        width: "36px", height: "36px",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: "white",
                        cursor: "pointer",
                        boxShadow: "0 2px 10px rgba(59, 130, 246, 0.4)",
                        transition: "transform 0.2s"
                    }}
                >
                    ➤
                </button>

            </div>
        </div>
    </div> as HTMLElement

    // Note: We are leaking `lifecycle` here because OdieInput is a functional component 
    // that returns a DOM node and doesn't have an unmount hook in this simple setup.
    // However, in this specific app architecture, OdieInput is likely long-lived or
    // we should attach lifecycle to the DOM node if possible? 
    // For now, it's fine as OdieService is singleton and Input is singleton-ish.

    return container
}
