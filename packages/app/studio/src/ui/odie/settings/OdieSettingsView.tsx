import { createElement } from "@opendaw/lib-jsx"
import { Lifecycle, DefaultObservableValue } from "@opendaw/lib-std"
import { OdieService } from "../OdieService"
import { Colors } from "@opendaw/studio-enums"
import { Button } from "@/ui/components/Button"
import { TextInput } from "@/ui/components/TextInput"
import { Palette, Spacing, Typography } from "../OdieTheme"
import { OdieMetrics } from "../OdieMetrics"

// --- Helper Types & Imports ---

interface OdieSettingsViewProps {
    lifecycle: Lifecycle
    odieService: OdieService
    onClose: () => void
}

// Helper for dynamic rendering (reused pattern)
const ObserverView = (
    lifecycle: Lifecycle,
    observable: DefaultObservableValue<any>,
    renderer: (val: any) => HTMLElement | null
) => {
    const container = document.createElement("div")
    container.style.display = "contents" // Don't break layout

    const update = (val: any) => {
        container.innerHTML = ""
        const content = renderer(val)
        if (content) container.appendChild(content)
    }

    lifecycle.own(observable.subscribe(update))
    update(observable.getValue()) // Initial

    return container
}

export const OdieSettingsView = ({ lifecycle, odieService, onClose }: OdieSettingsViewProps) => {

    const activeTab = new DefaultObservableValue<"intelligence" | "performance">("intelligence")
    const ollamaModels = new DefaultObservableValue<string[]>([])
    const ollamaStatus = new DefaultObservableValue<{ status: 'idle' | 'checking' | 'success' | 'error', message: string }>({ status: 'idle', message: "" })

    // --- Helper Components ---

    const SectionHeader = ({ title, desc, icon }: { title: string, desc: string, icon?: string }) => (
        <div style={{ display: "flex", gap: Spacing.md, marginBottom: Spacing.lg }}>
            <div style={{
                fontSize: "24px", background: Palette.zinc[800], width: "48px", height: "48px",
                borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: "0"
            }}>{icon || "⚙️"}</div>
            <div>
                <div style={{ fontWeight: "600", fontSize: "16px", color: Colors.white.toString() }}>{title}</div>
                <div style={{ ...Typography.body, color: Palette.text.secondary }}>{desc}</div>
            </div>
        </div>
    )

    // --- GEMINI COGNITIVE CONFIG ---
    const RenderGeminiCognitive = () => {
        const providerId = "gemini"
        const config = odieService.ai.getConfig(providerId)

        // Ensure defaults if missing
        if (!config.thinkingLevel) config.thinkingLevel = "high"
        if (!config.mediaResolution) config.mediaResolution = "high"

        return <div style={{
            background: Palette.zinc[900], border: `1px solid ${Palette.zinc[800]}`,
            borderRadius: "12px", padding: Spacing.lg, marginBottom: Spacing.xl
        }}>
            <SectionHeader
                title="Gemini Cognitive (V3 Preview)"
                desc="Experimental System 2 reasoning engine. Best for complex logic and creative direction."
                icon="✨"
            />

            {/* API Key Management */}
            <div style={{ marginBottom: Spacing.xl }}>
                <label style={{ ...Typography.tiny, color: Palette.text.secondary, marginBottom: "8px", display: "block" }}>GOOGLE AI STUDIO KEY (REQUIRED)</label>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <div style={{
                        flex: "1", background: Palette.background, border: `1px solid ${Palette.border}`,
                        borderRadius: "6px", padding: "10px", fontFamily: "monospace", color: Palette.text.secondary, fontSize: "13px"
                    }}>
                        {config.apiKey ? `••••••••••••${config.apiKey.slice(-4)}` : "No API Key Set"}
                    </div>
                    <Button lifecycle={lifecycle} appearance={{ framed: true }} onClick={() => {
                        const key = prompt("Enter your Google Gemini API Key")
                        if (key) {
                            const newConfig = { ...config, apiKey: key }
                            odieService.ai.setConfig(providerId, newConfig)
                            activeTab.setValue("intelligence") // force refresh
                        }
                    }}>Edit Key</Button>
                </div>
                <a href="https://aistudio.google.com/app/apikey" target="_blank" style={{ fontSize: "12px", color: Palette.accent, marginTop: "8px", display: "inline-block", textDecoration: "none" }}>Get Free Availability Key →</a>
            </div>

            {/* Thinking Depth Slider */}
            <div style={{ marginBottom: Spacing.xl, paddingBottom: Spacing.xl, borderBottom: `1px solid ${Palette.zinc[800]}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <label style={{ fontSize: "13px", color: Palette.text.primary, fontWeight: "600" }}>Thinking Depth</label>
                    <span style={{ fontSize: "12px", color: Palette.accent }}>{config.thinkingLevel?.toUpperCase()}</span>
                </div>
                <div style={{ ...Typography.tiny, color: Palette.text.secondary, marginBottom: "12px" }}>
                    Controls the reasoning effort. Higher values produce better code but take longer.
                </div>
                <div style={{ display: "flex", gap: "4px", height: "32px" }}>
                    {["minimal", "low", "medium", "high"].map((level, i) => {
                        const levels = ["minimal", "low", "medium", "high"]
                        const currentIndex = levels.indexOf(config.thinkingLevel || "high")
                        const isActive = currentIndex >= i
                        const isSelected = config.thinkingLevel === level

                        return <div style={{
                            flex: "1", borderRadius: "4px",
                            background: isActive ? Palette.accent : Palette.zinc[800],
                            opacity: isActive ? (isSelected ? "1" : "0.6") : "0.3",
                            cursor: "pointer",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: "10px", fontWeight: "600", color: Colors.white.toString(),
                            transition: "all 0.2s ease"
                        }} onclick={() => {
                            config.thinkingLevel = level as any
                            odieService.ai.setConfig(providerId, config)
                            activeTab.setValue("intelligence")
                        }}>
                            {level.toUpperCase()}
                        </div>
                    })}
                </div>
            </div>

            {/* Vision Fidelity Selector */}
            <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <label style={{ fontSize: "13px", color: Palette.text.primary, fontWeight: "600" }}>Vision Fidelity</label>
                    <span style={{ fontSize: "12px", color: Palette.text.secondary }}>NANO BANANA PRO</span>
                </div>
                <div style={{ ...Typography.tiny, color: Palette.text.secondary, marginBottom: "12px" }}>
                    Resolution for image generation and visual analysis.
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                    {["low", "medium", "high", "ultra_high"].map(res => (
                        <div style={{
                            padding: "6px 12px", borderRadius: "6px", fontSize: "11px", cursor: "pointer",
                            background: config.mediaResolution === res ? Palette.accent : Palette.zinc[800],
                            color: config.mediaResolution === res ? Colors.white.toString() : Palette.text.secondary,
                            border: `1px solid ${config.mediaResolution === res ? Palette.accent : "transparent"}`
                        }} onclick={() => {
                            config.mediaResolution = res as any
                            odieService.ai.setConfig(providerId, config)
                            activeTab.setValue("intelligence")
                        }}>{res.replace("_", " ").toUpperCase()}</div>
                    ))}
                </div>
            </div>
        </div>
    }

    // --- OLLAMA LOCAL CONFIG ---
    const RenderOllamaLocal = () => {
        const providerId = "ollama"
        const config = odieService.ai.getConfig(providerId)

        const scanOllama = async () => {
            ollamaStatus.setValue({ status: 'checking', message: "Scanning local server..." })
            try {
                // Fetch tags from local ollama
                const res = await fetch("http://localhost:11434/api/tags")
                if (res.ok) {
                    const data = await res.json()
                    const models = data.models?.map((m: any) => m.name.toString()) || []
                    ollamaModels.setValue(models)
                    ollamaStatus.setValue({ status: 'success', message: `Found ${models.length} models.` })
                } else {
                    ollamaStatus.setValue({ status: 'error', message: "Connection refused. Is Ollama running?" })
                }
            } catch (e) {
                ollamaStatus.setValue({ status: 'error', message: "Could not connect to localhost:11434" })
            }
        }

        return <div style={{
            background: Palette.zinc[900], border: `1px solid ${Palette.zinc[800]}`,
            borderRadius: "12px", padding: Spacing.lg, marginBottom: Spacing.xl
        }}>
            <SectionHeader
                title="Ollama (Local Brain)"
                desc="Private, offline execution. Your data never leaves this machine."
                icon="🔒"
            />

            {/* Warning / Guidance */}
            <div style={{
                background: "#422006", border: "1px solid #a16207", color: "#fcd34d",
                padding: "12px", borderRadius: "8px", fontSize: "13px", marginBottom: Spacing.lg
            }}>
                ⚠️ <strong>Hardware Requirement:</strong> Local Text-to-Audio requires significant RAM. We recommend 64GB+ Unified Memory for standard models.
            </div>

            {/* Status & Scan */}
            <div style={{ display: "flex", gap: "10px", marginBottom: Spacing.lg }}>
                <Button lifecycle={lifecycle} appearance={{ framed: true }} onClick={scanOllama}>
                    Scan for Models
                </Button>
                {ObserverView(lifecycle, ollamaStatus, (s) => (
                    <div style={{
                        display: "flex", alignItems: "center", gap: "8px", fontSize: "13px",
                        color: s.status === 'success' ? Colors.green.toString() : s.status === 'error' ? Colors.red.toString() : Palette.text.secondary
                    }}>
                        {s.status !== 'idle' && (
                            [<div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "currentColor" }} key="dot" />,
                            <span key="msg">{s.message}</span>]
                        )}
                    </div>
                ))}
            </div>

            {/* Model Selection */}
            <div style={{ marginBottom: Spacing.lg }}>
                <label style={{ ...Typography.tiny, color: Palette.text.secondary, marginBottom: "8px", display: "block" }}>SELECTED MODEL</label>
                {/* Fallback Input if scan fails, or Dropdown if models found */}
                {ObserverView(lifecycle, ollamaModels, (models: string[]) => {
                    if (models.length > 0) {
                        return <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                            {models.map((m: string) => (
                                <div style={{
                                    padding: "10px", background: config.modelId === m ? Palette.zinc[800] : Palette.background,
                                    border: `1px solid ${config.modelId === m ? Palette.accent : Palette.border}`,
                                    borderRadius: "6px", cursor: "pointer", display: "flex", justifyContent: "space-between",
                                    alignItems: "center"
                                }} onclick={() => {
                                    odieService.ai.setConfig(providerId, { ...config, modelId: m })
                                    activeTab.setValue("intelligence")
                                }}>
                                    <span style={{ color: Palette.text.primary, fontSize: "13px" }}>{m}</span>
                                    {config.modelId === m && <span style={{ color: Palette.accent }}>● Active</span>}
                                </div>
                            ))}
                        </div>
                    } else {
                        // Create proxy observable for Input
                        const inputModel = new DefaultObservableValue(config.modelId || "llama3")
                        // Sync changes back to config
                        lifecycle.own(inputModel.subscribe((val: any) => {
                            odieService.ai.setConfig(providerId, { ...config, modelId: val as string })
                        }))

                        return <div style={{ display: "flex", gap: "10px" }}>
                            <TextInput
                                lifecycle={lifecycle}
                                model={inputModel}
                                className="full-width-input"
                            />
                        </div>
                    }
                })}
            </div>

            <div style={{ fontSize: "12px", color: Palette.text.secondary }}>
                Don't have Ollama? <a href="https://ollama.com" target="_blank" style={{ color: Palette.accent }}>Download & Install</a>
            </div>
        </div>
    }


    return (
        <div style={{
            position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
            background: Palette.background, zIndex: "9999",
            display: "flex", flexDirection: "column",
            fontFamily: "Inter, sans-serif", color: Palette.text.primary
        }}>
            {/* --- HEADER --- */}
            <div style={{
                height: "60px", borderBottom: `1px solid ${Palette.border}`, display: "flex", alignItems: "center",
                padding: `0 ${Spacing.lg}`, justifyContent: "space-between", background: Palette.panel
            }}>
                <div style={{ display: "flex", alignItems: "center", gap: Spacing.md }}>
                    <h2 style={{ ...Typography.h3, margin: "0" }}>Odie Settings</h2>
                </div>
                <Button lifecycle={lifecycle}
                    appearance={{ framed: true }}
                    onClick={onClose}
                >
                    Done
                </Button>
            </div>

            {/* --- BODY --- */}
            <div style={{ flex: "1", display: "flex", overflow: "hidden" }}>
                {/* SIDEBAR TABS */}
                <div style={{ width: "240px", borderRight: `1px solid ${Palette.border}`, padding: Spacing.md, background: Palette.panel }}>
                    {[
                        { id: "intelligence", label: "Intelligence", icon: "🧠" },
                        { id: "performance", label: "Performance", icon: "📊" }
                    ].map(tab => (
                        <div key={tab.id} style={{ cursor: "pointer", marginBottom: "4px" }} onclick={() => activeTab.setValue(tab.id as any)}>
                            {ObserverView(lifecycle, activeTab, (current) => {
                                const isSelected = current === tab.id
                                return <div style={{
                                    padding: "10px 12px", borderRadius: "6px", display: "flex", alignItems: "center", gap: "10px",
                                    background: isSelected ? Palette.zinc[800] : "transparent",
                                    color: isSelected ? Palette.text.primary : Palette.text.secondary,
                                    fontWeight: isSelected ? "600" : "400", ...Typography.body
                                }}>
                                    <span>{tab.icon}</span> <span>{tab.label}</span>
                                </div>
                            })}
                        </div>
                    ))}
                </div>

                {/* CONTENT AREA */}
                <div style={{ flex: "1", padding: Spacing.xl, overflowY: "auto", background: Palette.background }}>
                    {ObserverView(lifecycle, activeTab, (tab) => {
                        const content = document.createElement("div")
                        content.style.maxWidth = "800px"

                        if (tab === "intelligence") {
                            content.appendChild(<div style={{ marginBottom: Spacing.xl }}>
                                <h1 style={{ ...Typography.h2, color: Colors.white.toString(), marginBottom: "8px" }}>Neural Configuration</h1>
                                <p style={{ ...Typography.body, color: Palette.text.secondary }}>Manage cloud and local inference engines.</p>
                            </div>)

                            // Render Both Forms
                            content.appendChild(RenderGeminiCognitive())
                            content.appendChild(RenderOllamaLocal())

                        } else if (tab === "performance") {
                            content.appendChild(<div style={{ marginBottom: Spacing.xl }}>
                                <h1 style={{ ...Typography.h2, color: Colors.white.toString(), marginBottom: "8px" }}>System Metrics</h1>
                                <p style={{ ...Typography.body, color: Palette.text.secondary }}>Real-time telemetry and debug information.</p>
                            </div>)
                            content.appendChild(<div style={{ maxWidth: "100%" }}><OdieMetrics service={odieService} /></div>)
                        }
                        return content
                    })}
                </div>
            </div>
        </div>
    )
}
