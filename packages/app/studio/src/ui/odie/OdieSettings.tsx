import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { OdieMetrics } from "./OdieMetrics"

export const OdieSettings = ({ service, onBack, isEmbedded = false }: { service: OdieService, onBack: () => void, isEmbedded?: boolean }) => {
    // Styling Constants
    const S = {
        container: {
            display: "flex", flexDirection: "column", height: "100%", width: "100%",
            background: isEmbedded ? "transparent" : "#111827",
            color: "white", fontFamily: "Inter, sans-serif"
        },
        header: {
            padding: "16px 24px", borderBottom: "1px solid rgba(255,255,255,0.1)",
            display: isEmbedded ? "none" : "flex", // Hide header if embedded
            alignItems: "center", justifyContent: "space-between", background: "rgba(0,0,0,0.2)"
        },
        main: {
            flex: "1", padding: "24px", overflowY: "auto", position: "relative"
        },
        // Provider Select
        selectWrapper: {
            display: "flex", alignItems: "center", gap: "12px", flex: "1"
        },
        select: {
            padding: "10px 16px", borderRadius: "8px", background: "#1f2937", color: "white",
            border: "1px solid #374151", fontSize: "14px", fontWeight: "600", cursor: "pointer",
            minWidth: "200px"
        },
        // Form
        label: { display: "block", fontSize: "11px", fontWeight: "700", color: "#9ca3af", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px" },
        input: {
            width: "100%", padding: "12px", borderRadius: "8px", background: "#000",
            border: "1px solid #374151", color: "white", fontSize: "14px", fontFamily: "monospace"
        },
        // Get Key Button
        getKeyBtn: {
            display: "inline-flex", alignItems: "center", gap: "6px", padding: "0 12px", height: "42px",
            borderRadius: "8px", background: "#2563eb", color: "white", fontSize: "13px", fontWeight: "600",
            textDecoration: "none", border: "1px solid #3b82f6", whiteSpace: "nowrap", cursor: "pointer",
            transition: "all 0.2s"
        },
        // Footer
        footer: {
            padding: "16px 24px", borderTop: "1px solid rgba(255,255,255,0.1)",
            display: isEmbedded ? "none" : "flex", // Hide footer if embedded
            justifyContent: "space-between", alignItems: "center", background: "#0d1117"
        }
    }

    const container = <div style={S.container}></div> as HTMLElement

    // -- STATE --
    let activeTab: "config" | "metrics" = "config"

    // [ANTIGRAVITY] Main Content Slot
    const content = <div style={S.main}></div> as HTMLElement

    // -- HELPER COMPONENTS --

    const ConnectionStatus = ({ status, message }: { status: 'idle' | 'checking' | 'success' | 'error', message: string }) => {
        const color = status === 'success' ? '#10b981' : status === 'error' ? '#ef4444' : status === 'checking' ? '#eab308' : '#6b7280'
        const displayMessage = message.length > 200 ? message.slice(0, 200) + "..." : message
        return (
            <div style={{
                display: "flex", alignItems: "start", gap: "12px",
                background: "rgba(0,0,0,0.3)", padding: "16px", borderRadius: "12px",
                marginTop: "24px", border: `1px solid ${status === 'checking' ? 'rgba(255,255,255,0.1)' : color}`,
                maxHeight: "100px", overflowY: "auto"
            }}>
                <div style={{
                    minWidth: "10px", height: "10px", borderRadius: "50%", background: color,
                    marginTop: "6px", boxShadow: `0 0 12px ${color}`
                }} />
                <div style={{ fontSize: "13px", lineHeight: "1.5", flex: "1", color: status === 'error' ? '#fca5a5' : '#e5e7eb', wordBreak: "break-word" }}>
                    {status === 'checking' ? "Verifying connection..." : displayMessage}
                </div>
            </div>
        )
    }

    const ConfigCard = async (providerId: string, root: HTMLElement, overrides?: { title?: string, desc?: string, helpText?: string, getKeyUrl?: string }) => {
        root.innerHTML = ""
        const provider = service.ai.getProvider(providerId)
        if (!provider) return

        const config = service.ai.getConfig(providerId)
        const title = overrides?.title || provider.manifest.name
        const desc = overrides?.desc || provider.manifest.description

        const wrapper = <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "800px", margin: "0 auto" }}></div> as HTMLElement
        const validationArea = <div style={{ maxWidth: "520px", width: "100%" }}></div> as HTMLElement
        const keyLibrary: string[] = config.keyLibrary || []
        if (keyLibrary.length === 0 && config.apiKey) keyLibrary.push(config.apiKey)
        const activeKey = keyLibrary[0]

        const saveConfig = () => {
            const newConfig = { ...config, keyLibrary: keyLibrary, apiKey: keyLibrary[0] || "" }
            service.ai.setConfig(provider.id, newConfig)
        }

        const runValidation = async (tempKey?: string, tempUrl?: string) => {
            validationArea.innerHTML = ""
            validationArea.appendChild(ConnectionStatus({ status: 'checking', message: "" }))
            const newConfig = { ...config }
            if (tempKey !== undefined) newConfig.apiKey = tempKey
            if (tempUrl !== undefined) newConfig.baseUrl = tempUrl
            service.ai.setConfig(provider.id, newConfig)

            if (provider.validate) {
                const res = await provider.validate()
                validationArea.innerHTML = ""
                validationArea.appendChild(ConnectionStatus({ status: res.ok ? 'success' : 'error', message: res.message }))
                if (res.ok && provider.id.includes("gemini")) {
                    const statusDiv = <div style={{ marginTop: "16px", padding: "10px", background: "rgba(139, 92, 246, 0.1)", border: "1px solid rgba(139, 92, 246, 0.2)", borderRadius: "8px", color: "#a78bfa", fontSize: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <div style={{ fontWeight: "700" }}>✨ GEMINI AUTO-PILOT ACTIVE</div>
                            <div style={{ opacity: "0.8" }}>Dual-Brain Engine Online</div>
                        </div>
                    </div>
                    validationArea.appendChild(statusDiv)
                } else if (res.ok && provider.fetchModels) {
                    const models = await provider.fetchModels()
                    if (models.length > 0) {
                        const modelPicker = <div style={{ marginTop: "20px" }}>
                            <label style={S.label}>SELECT MODEL</label>
                            <select style={S.input} onchange={(e: any) => { config.modelId = e.target.value; saveConfig() }}>
                                {models.map(m => <option value={m} selected={m === config.modelId}>{m}</option>)}
                            </select>
                        </div>
                        validationArea.appendChild(modelPicker)
                    }
                }
            }
        }

        // TOP SECTION
        const top = <div style={{ display: "flex", gap: "24px", paddingBottom: "24px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
            <div style={{ fontSize: "42px", background: "rgba(255,255,255,0.05)", padding: "16px", borderRadius: "16px" }}>{provider.manifest.icon || "🤖"}</div>
            <div style={{ flex: "1" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <h3 style={{ fontSize: "20px", fontWeight: "700", margin: "0" }}>{title}</h3>
                    <div style={{ display: "flex", gap: "8px" }}>
                        <button style={{ background: "#2563eb", color: "white", padding: "8px 16px", borderRadius: "6px", border: "none", cursor: "pointer", fontSize: "12px" }} onclick={() => runValidation()}>Test Connection</button>
                    </div>
                </div>
                <div style={{ fontSize: "14px", color: "#9ca3af", marginTop: "8px" }}>{desc}</div>
            </div>
        </div>
        wrapper.appendChild(top)

        if (provider.requiresUrl) {
            wrapper.appendChild(<div style={{ background: "#111", padding: "16px", borderRadius: "8px", border: "1px solid #333" }}>
                <label style={S.label}>ENDPOINT URL</label>
                <input type="text" value={config.baseUrl || ""} style={S.input} onchange={(e: any) => { config.baseUrl = e.target.value; saveConfig() }} />
            </div>)
        }

        wrapper.appendChild(validationArea)

        if (provider.requiresKey) {
            wrapper.appendChild(<div style={{ background: "rgba(0,0,0,0.2)", padding: "12px", borderRadius: "8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", gap: "12px" }}>
                    <span style={S.label}>Active Key:</span>
                    <span style={{ fontFamily: "monospace", color: "#10b981" }}>••••{activeKey?.slice(-6)}</span>
                </div>
                <button style={{ background: "transparent", border: "1px solid #333", color: "#999", padding: "4px 8px", borderRadius: "4px", fontSize: "10px" }} onclick={() => {
                    const key = prompt("Enter new API Key")
                    if (key) { config.apiKey = key; saveConfig(); render() }
                }}>Change</button>
            </div>)
        }

        root.appendChild(wrapper)
        if (!isEmbedded) runValidation()
    }

    const renderThinkingSlider = (config: any, providerId: string) => {
        const levels = ["minimal", "low", "medium", "high"]
        const current = config.thinkingLevel || "high"
        const idx = levels.indexOf(current)
        return <div style={{ background: "rgba(168, 85, 247, 0.1)", padding: "16px", borderRadius: "8px", border: "1px solid rgba(168, 85, 247, 0.3)", marginTop: "24px" }}>
            <label style={S.label}>🧠 THINKING DEPTH: {current.toUpperCase()}</label>
            <input type="range" min="0" max="3" value={idx.toString()} style={{ width: "100%" }} onchange={(e: any) => { config.thinkingLevel = levels[parseInt(e.target.value)]; service.ai.setConfig(providerId, config); render() }} />
        </div>
    }

    const renderMediaResolutionControl = (config: any, providerId: string) => {
        const resolutions = ["LOW", "MEDIUM", "HIGH", "ULTRA_HIGH"]
        const current = config.mediaResolution || "ULTRA_HIGH"
        return <div style={{ background: "rgba(16, 185, 129, 0.1)", padding: "16px", borderRadius: "8px", border: "1px solid rgba(16, 185, 129, 0.3)", marginTop: "12px" }}>
            <label style={S.label}>📷 VISION FIDELITY: {current}</label>
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                {resolutions.map(r => <button style={{ flex: "1", padding: "8px", background: current === r ? "#10b981" : "#1f2937", border: "none", color: "white", borderRadius: "4px", fontSize: "10px" }} onclick={() => { config.mediaResolution = r; service.ai.setConfig(providerId, config); render() }}>{r}</button>)}
            </div>
        </div>
    }

    // -- RENDER ENGINE --

    const renderHeader = () => {
        return <div style={S.header}>
            <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <span style={{ fontSize: "20px" }}>⚙️</span>
                    <span style={{ fontSize: "16px", fontWeight: "700" }}>Odie Settings</span>
                </div>
                <div style={{ display: "flex", gap: "4px", background: "rgba(0,0,0,0.3)", padding: "4px", borderRadius: "8px" }}>
                    <div onclick={() => { activeTab = "config"; render() }} style={{ padding: "6px 14px", borderRadius: "6px", cursor: "pointer", background: activeTab === "config" ? "#2563eb" : "transparent", color: activeTab === "config" ? "white" : "#9ca3af", fontSize: "12px", fontWeight: "600" }}>Config</div>
                    <div onclick={() => { activeTab = "metrics"; render() }} style={{ padding: "6px 14px", borderRadius: "6px", cursor: "pointer", background: activeTab === "metrics" ? "#10b981" : "transparent", color: activeTab === "metrics" ? "white" : "#9ca3af", fontSize: "12px", fontWeight: "600" }}>Metrics</div>
                </div>
                {activeTab === "config" && <div style={{ width: "1px", height: "20px", background: "rgba(255,255,255,0.1)", margin: "0 8px" }}></div>}
                {activeTab === "config" && <div style={{ display: "flex", gap: "4px" }}>
                    {service.ai.getProviders().filter(p => !p.id.includes("openai") && !p.id.includes("anthropic")).map(p => {
                        const isActive = service.ai.activeProviderId.getValue() === p.id
                        return <div onclick={() => { service.ai.setActiveProvider(p.id); render() }} style={{ padding: "6px 12px", borderRadius: "6px", cursor: "pointer", border: isActive ? "1px solid #3b82f6" : "1px solid transparent", background: isActive ? "rgba(59,130,246,0.1)" : "transparent", color: isActive ? "white" : "#6b7280", fontSize: "11px", fontWeight: "700" }}>
                            {p.id === "gemini" ? "STD" : p.id === "gemini-3" ? "COG" : "LOC"}
                        </div>
                    })}
                </div>}
            </div>
            {!isEmbedded && <button onclick={onBack} style={{ background: "none", border: "none", fontSize: "20px", cursor: "pointer", color: "#6b7280" }}>✕</button>}
        </div> as HTMLElement
    }

    const renderContent = (id: string) => {
        content.innerHTML = ""
        if (activeTab === "metrics") {
            content.appendChild(<OdieMetrics service={service} />)
            return
        }
        if (id === "gemini") {
            ConfigCard(id, content, { title: "Gemini Standard (V2.5)", desc: "Optimized for speed. Powered by Gemini 3 Flash.", getKeyUrl: "https://aistudio.google.com/app/apikey" })
        } else if (id === "gemini-3") {
            ConfigCard(id, content, { title: "Gemini Cognitive (V3 Preview)", desc: "Experimental System 2 reasoning engine.", getKeyUrl: "https://aistudio.google.com/app/apikey" }).then(() => {
                const card = content.querySelector('div[style*="max-width: 800px"]') as HTMLElement
                if (card) {
                    const config = service.ai.getConfig(id)
                    card.appendChild(renderThinkingSlider(config, id))
                    card.appendChild(renderMediaResolutionControl(config, id))
                }
            })
        } else if (id.includes("ollama")) {
            ConfigCard(id, content, { title: "Ollama (Local)", desc: "Private and offline execution.", getKeyUrl: "https://ollama.com" })
        } else {
            ConfigCard(id, content)
        }
    }

    const renderFooter = () => {
        return <div style={S.footer}>
            <button onclick={() => { if (confirm("Reset?")) { service.ai.resetWizard(); location.reload() } }} style={{ color: "#ef4444", background: "transparent", border: "none", fontSize: "11px", cursor: "pointer" }}>Reset Wizard</button>
            <button onclick={onBack} style={{ background: "#2563eb", color: "white", padding: "10px 24px", borderRadius: "6px", border: "none", cursor: "pointer" }}>Done</button>
        </div> as HTMLElement
    }

    const render = () => {
        container.innerHTML = ""
        container.appendChild(renderHeader())
        container.appendChild(content)
        container.appendChild(renderFooter())
        renderContent(service.ai.activeProviderId.getValue())
    }

    render()
    return container
}
