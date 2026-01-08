import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { Terminator } from "@opendaw/lib-std"

type SuggestionType = "chat" | "action" | "system"

interface Suggestion {
    label: string
    type: SuggestionType
    action?: () => void // Direct execution override
    prompt?: string // Text to send
    icon?: string
}

const COLORS = {
    chat: {
        bg: "rgba(34, 197, 94, 0.1)", // Green
        border: "rgba(34, 197, 94, 0.3)",
        text: "#4ade80",
        hover: "rgba(34, 197, 94, 0.2)"
    },
    action: {
        bg: "rgba(59, 130, 246, 0.1)", // Blue
        border: "rgba(59, 130, 246, 0.3)",
        text: "#60a5fa",
        hover: "rgba(59, 130, 246, 0.2)"
    },
    system: {
        bg: "rgba(168, 85, 247, 0.1)", // Purple
        border: "rgba(168, 85, 247, 0.3)",
        text: "#c084fc",
        hover: "rgba(168, 85, 247, 0.2)"
    }
}

export const OdieSuggestions = ({ service }: { service: OdieService }) => {

    const container = <div className="odie-suggestions" style={{
        display: "flex",
        gap: "8px",
        overflowX: "auto",
        padding: "12px 16px",
        whiteSpace: "nowrap",
        // Hide scrollbar
        // scrollbarWidth: "none", // This is fine usually but let's be safe
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        background: "rgba(15, 23, 42, 0.5)" // Subtle bg
    }}>
    </div> as HTMLElement

    // Scrollbar hiding for Webkit
    const style = <style>{`
        .odie-suggestions::-webkit-scrollbar { display: none; }
        .odie-suggestions { -ms-overflow-style: none; scrollbar-width: none; }
    `}</style>
    container.appendChild(style)

    const lifecycle = new Terminator()

    // Wrapper for chips
    const chipsWrapper = <div style={{ display: "flex", gap: "8px" }}></div> as HTMLElement
    container.appendChild(chipsWrapper)

    const render = () => {
        chipsWrapper.innerHTML = ""
        const messages = service.messages.getValue()
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null
        const isModel = lastMsg?.role === "model"
        const suggestions: Suggestion[] = []

        // --- 1. PROJECT STATE SENSORS (The "Eyes") ---
        let isPlaying = false
        let trackCount = 0
        let hasProject = false

        if (service.studio) {
            try {
                // Check Playback
                if (service.studio.engine?.isPlaying) {
                    isPlaying = service.studio.engine.isPlaying.getValue()
                }

                // Check Tracks
                if (service.studio.hasProfile && service.studio.profile?.project?.rootBoxAdapter) {
                    hasProject = true
                    const adapters = service.studio.profile.project.rootBoxAdapter.audioUnits.adapters()
                    // Filter out master output usually? "adapters()" returns array of wrappers.
                    // Let's assume length is good enough proxy.
                    trackCount = adapters.length
                }
            } catch (e) {
                // console.warn("OdieSensors Error", e)
            }
        }

        // --- 2. DYNAMIC SUGGESTIONS ---

        // A. Transport (Always relevant)
        if (hasProject) {
            if (isPlaying) {
                suggestions.push({ label: "Stop", type: "action", action: () => service.studio?.engine.stop(), icon: "⏹️" })
                suggestions.push({ label: "Add Marker", type: "action", prompt: "Add a marker here", icon: "📍" })
            } else {
                suggestions.push({ label: "Play", type: "action", action: () => service.studio?.engine.play(), icon: "▶️" })
            }
        }

        // B. Composition / Project State
        if (hasProject) {
            if (trackCount < 2) {
                suggestions.push({ label: "Add Track", type: "action", prompt: "Add a generic instrument track", icon: "🎹" })
                suggestions.push({ label: "Set BPM", type: "action", prompt: "Set BPM to 128", icon: "⏱️" })
            }
            if (trackCount > 3) {
                suggestions.push({ label: "Export Mixdown", type: "system", prompt: "Export a mixdown", icon: "💿" })
            }
        } else {
            // No Project Loaded
            suggestions.push({ label: "New Project", type: "system", action: () => service.studio?.newProject(), icon: "✨" })
            suggestions.push({ label: "Open Project", type: "system", action: () => service.studio?.browseLocalProjects(), icon: "📂" })
        }

        // C. Chat Context (The "Ears")
        if (messages.length === 0) {
            // Starter Pack
            suggestions.push({ label: "Give ideas", type: "chat", prompt: "Suggest some creative next steps for this song.", icon: "💡" })
        } else {
            const content = lastMsg?.content.toLowerCase() || ""

            // Content Analysis
            if (content.includes("track") || content.includes("channel")) {
                if (trackCount > 0) suggestions.push({ label: "List Tracks", type: "action", prompt: "List all tracks", icon: "📋" })
                else suggestions.push({ label: "Add Track", type: "action", prompt: "Add a new track", icon: "➕" })
            }
            if (content.includes("error") || content.includes("failed")) {
                suggestions.push({ label: "Fix it", type: "chat", prompt: "How can I fix the error?", icon: "🔧" })
            }

            // Copy Utility
            suggestions.push({
                label: "Copy", type: "system", action: () => {
                    if (lastMsg && lastMsg.content) navigator.clipboard.writeText(lastMsg.content)
                }, icon: "📋"
            })

            // Chat Flow
            if (isModel) {
                suggestions.push(
                    { label: "Tell me more", type: "chat", prompt: "Elaborate on that.", icon: "💬" }
                )
            }
        }

        // --- RENDER LOOP ---
        suggestions.forEach(s => {
            const theme = COLORS[s.type]
            const chip = <button style={{
                background: theme.bg,
                border: `1px solid ${theme.border}`,
                color: theme.text,
                padding: "6px 12px",
                borderRadius: "16px",
                fontSize: "12px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                transition: "all 0.2s",
                fontWeight: "500",
                flexShrink: "0"
            }}
                onmouseenter={(e: any) => {
                    e.currentTarget.style.background = theme.hover
                    e.currentTarget.style.transform = "translateY(-1px)"
                }}
                onmouseleave={(e: any) => {
                    e.currentTarget.style.background = theme.bg
                    e.currentTarget.style.transform = "translateY(0)"
                }}
                onclick={(e: any) => {
                    // Visual feedback
                    const btn = e.currentTarget as HTMLElement
                    btn.style.transform = "scale(0.95)"
                    setTimeout(() => {
                        if (btn) btn.style.transform = "scale(1)"
                    }, 100)

                    if (s.action) {
                        s.action()
                    } else if (s.prompt) {
                        service.sendMessage(s.prompt)
                    }
                }}
            >
                <span style={{ opacity: "0.8" }}>{s.icon}</span>
                {s.label}
            </button> as HTMLElement
            chipsWrapper.appendChild(chip)
        })
    }

    // --- SUBSCRIPTIONS ---

    // 1. Chat Updates
    lifecycle.own(service.messages.subscribe(() => render()))

    // 2. Studio Updates (Dynamic Binding)
    // Since service.studio is not observable itself, we might check it once or assume it's there.
    // If it's available at mount (which it should be in OdieSidebar), we bind.
    if (service.studio) {
        // Bind Playback
        if (service.studio.engine?.isPlaying) {
            lifecycle.own(service.studio.engine.isPlaying.subscribe(() => render()))
        }

        // Use a safe studio update listener if available, otherwise rely on manual updates
        // We avoid accessing studio.profile directly here as it may panic if no project is loaded.
    }

    render() // Initial

    return container
}
