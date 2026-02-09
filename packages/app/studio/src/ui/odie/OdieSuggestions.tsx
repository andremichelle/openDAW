import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { Terminator } from "@opendaw/lib-std"

type SuggestionType = "chat" | "action" | "system"

interface Suggestion {
    label: string
    type: SuggestionType
    action?: () => void
    prompt?: string
    icon?: string
}

const COLORS = {
    chat: {
        bg: "rgba(34, 197, 94, 0.1)",
        border: "rgba(34, 197, 94, 0.3)",
        text: "#4ade80",
        hover: "rgba(34, 197, 94, 0.2)"
    },
    action: {
        bg: "rgba(59, 130, 246, 0.1)",
        border: "rgba(59, 130, 246, 0.3)",
        text: "#60a5fa",
        hover: "rgba(59, 130, 246, 0.2)"
    },
    system: {
        bg: "rgba(168, 85, 247, 0.1)",
        border: "rgba(168, 85, 247, 0.3)",
        text: "#c084fc",
        hover: "rgba(168, 85, 247, 0.2)"
    }
}

export const OdieSuggestions = ({ service }: { service: OdieService }) => {

    const container = <div className="odie-suggestions"
        role="region"
        aria-label="Suggestions"
        style={{
            display: "flex",
            gap: "8px",
            overflowX: "auto",
            padding: "12px 16px",
            whiteSpace: "nowrap",
            borderBottom: "1px solid rgba(255,255,255,0.05)",
            background: "rgba(15, 23, 42, 0.5)"
        }}>
    </div> as HTMLElement

    const style = <style>{`
        .odie-suggestions::-webkit-scrollbar { display: none; }
        .odie-suggestions { -ms-overflow-style: none; scrollbar-width: none; }
    `}</style>
    container.appendChild(style)

    const lifecycle = new Terminator()

    const chipsWrapper = <div style={{ display: "flex", gap: "8px" }}></div> as HTMLElement
    container.appendChild(chipsWrapper)

    const render = () => {
        chipsWrapper.innerHTML = ""
        const messages = service.messages.getValue()
        const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null
        const isModel = lastMsg?.role === "model"
        const suggestions: Suggestion[] = []

        // --- PROJECT STATE ---
        let isPlaying = false
        let trackCount = 0
        let hasProject = false

        const studio = service.studio.isEmpty() ? null : service.studio.unwrap()

        if (studio) {
            try {
                if (studio.engine.isPlaying) {
                    isPlaying = studio.engine.isPlaying.getValue()
                }

                if (studio.hasProfile && studio.profile?.project?.rootBoxAdapter) {
                    hasProject = true
                    const adapters = studio.profile.project.rootBoxAdapter.audioUnits.adapters()
                    trackCount = adapters.length
                }
            } catch (e) {
                // Ignore state errors during sync
            }
        }

        // --- DYNAMIC SUGGESTIONS ---

        // Transport
        if (hasProject) {
            if (isPlaying) {
                suggestions.push({ label: "Stop", type: "action", action: () => studio?.engine.stop(), icon: "⏹️" })
                suggestions.push({ label: "Add Marker", type: "action", prompt: "Add a marker here", icon: "📍" })
            } else {
                suggestions.push({ label: "Play", type: "action", action: () => studio?.engine.play(), icon: "▶️" })
            }
        }

        // Project Management
        if (hasProject) {
            if (trackCount < 2) {
                suggestions.push({ label: "Add Track", type: "action", prompt: "Add a generic instrument track", icon: "🎹" })
                suggestions.push({ label: "Set BPM", type: "action", prompt: "Set BPM to 128", icon: "⏱️" })
            }
            if (trackCount > 3) {
                suggestions.push({ label: "Export Mixdown", type: "system", prompt: "Export a mixdown", icon: "💿" })
            }
        } else {
            suggestions.push({ label: "New Project", type: "system", action: () => studio?.newProject(), icon: "✨" })
            suggestions.push({ label: "Open Project", type: "system", action: () => studio?.browseLocalProjects(), icon: "📂" })
        }

        // Chat Context
        if (messages.length === 0) {
            suggestions.push({ label: "Ideas", type: "chat", prompt: "Suggest some creative next steps for this song.", icon: "💡" })
        } else {
            const content = lastMsg?.content?.toLowerCase() || ""

            if (content.includes("track") || content.includes("channel")) {
                if (trackCount > 0) suggestions.push({ label: "List Tracks", type: "action", prompt: "List all tracks", icon: "📋" })
                else suggestions.push({ label: "Add Track", type: "action", prompt: "Add a new track", icon: "➕" })
            }
            if (content.includes("error") || content.includes("failed")) {
                suggestions.push({ label: "Resolve error", type: "chat", prompt: "How can I fix the error?", icon: "🔧" })
            }

            suggestions.push({
                label: "Copy", type: "system", action: () => {
                    if (lastMsg && lastMsg.content) navigator.clipboard.writeText(lastMsg.content)
                }, icon: "📋"
            })

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
                onmouseenter={(e: MouseEvent) => {
                    (e.currentTarget as HTMLElement).style.background = theme.hover;
                    (e.currentTarget as HTMLElement).style.transform = "translateY(-1px)";
                }}
                onmouseleave={(e: MouseEvent) => {
                    (e.currentTarget as HTMLElement).style.background = theme.bg;
                    (e.currentTarget as HTMLElement).style.transform = "translateY(0)";
                }}
                onclick={(e: MouseEvent) => {
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

    lifecycle.own(service.messages.subscribe(() => render()))

    if (service.studio) {
        service.studio.ifSome(studio => {
            if (studio.engine.isPlaying) {
                lifecycle.own(studio.engine.isPlaying.subscribe(() => render()))
            }
        })
    }

    render()

        // Important: Parent components must call this to prevent subscription leaks
        ; (container as unknown as { onDisconnect?: () => void }).onDisconnect = () => lifecycle.terminate()

    return container
}
