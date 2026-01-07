import css from "./OdieSettings.sass?inline"
import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { Html } from "@opendaw/lib-dom"
import { Dialogs } from "@/ui/components/dialogs"
import { Terminator } from "@opendaw/lib-std"

const className = Html.adoptStyleSheet(css, "OdieSettings")

export const OdieSettings = ({ service, lifecycle: _lifecycle, onBack, isEmbedded = false }: { service: OdieService, lifecycle: Terminator, onBack: () => void, isEmbedded?: boolean }) => {

    const container = <div className={Html.buildClassList(className, "container", isEmbedded && "embedded")}></div> as HTMLElement
    const content = <div className="main"></div> as HTMLElement

    // -- HELPER COMPONENTS --

    const ConnectionStatus = ({ status, message }: { status: 'idle' | 'checking' | 'success' | 'error', message: string }) => {
        const displayMessage = message.length > 200 ? message.slice(0, 200) + "..." : message
        const statusClass = status

        return (
            <div className={`connection-status ${statusClass}`}>
                <div style={{
                    minWidth: "8px", height: "8px", borderRadius: "50%",
                    background: "currentColor", opacity: 0.8
                }} />
                <div style={{ flex: "1", wordBreak: "break-word" }}>
                    {status === 'checking' ? "Verifying connection..." : displayMessage}
                </div>
            </div>
        )
    }

    const ConfigCard = ({ providerId, overrides }: { providerId: string, overrides?: any }) => {
        const provider = service.ai.getProvider(providerId)
        if (!provider) return <div className="error">Provider not found</div>

        const config = service.ai.getConfig(providerId)
        const title = overrides?.title || provider.manifest.name
        const desc = overrides?.desc || provider.manifest.description

        const keyLibrary: string[] = config.keyLibrary || []
        if (keyLibrary.length === 0 && config.apiKey) keyLibrary.push(config.apiKey)
        const activeKey = keyLibrary[0]

        // Async State Containers
        const validationSlot = <div className="validation-area"></div> as HTMLElement

        const saveConfig = () => {
            const newConfig = { ...config, keyLibrary: keyLibrary, apiKey: keyLibrary[0] || "" }
            service.ai.setConfig(provider.id, newConfig)
        }

        const runValidation = async (tempKey?: string, tempUrl?: string) => {
            validationSlot.innerHTML = ""
            validationSlot.appendChild(ConnectionStatus({ status: 'checking', message: "" }))

            const newConfig = { ...config }
            if (tempKey !== undefined) newConfig.apiKey = tempKey
            if (tempUrl !== undefined) newConfig.baseUrl = tempUrl
            service.ai.setConfig(provider.id, newConfig)

            if (provider.validate) {
                const res = await provider.validate()
                validationSlot.innerHTML = ""
                validationSlot.appendChild(ConnectionStatus({ status: res.ok ? 'success' : 'error', message: res.message }))

                if (res.ok && provider.fetchModels) {
                    const models = await provider.fetchModels()
                    if (models.length > 0) {
                        validationSlot.appendChild(
                            <div style={{ marginTop: "20px" }}>
                                <label className="label">Select Model</label>
                                <select className="settings-input native" onchange={(e: any) => { config.modelId = e.target.value; saveConfig() }}>
                                    {models.map(m => <option value={m} selected={m === config.modelId}>{m}</option>)}
                                </select>
                            </div>
                        )
                    }
                }
            }
        }

        // Trigger initial validation
        if (!isEmbedded) setTimeout(() => runValidation(), 0)

        // Determine if we should show the "Extras" (sliders)
        const isActive = service.ai.activeProviderId.getValue() === providerId

        return <div className={`config-group ${isActive ? 'active' : ''}`}>

            {/* Header Area */}
            <div className="provider-header">
                {/* <div className="icon-box">{provider.manifest.icon || "?"}</div> NO EMOJI */}
                <div className="info">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h3>{title}</h3>
                        <button className="btn-secondary" onclick={() => runValidation()}>Test Connection</button>
                    </div>
                    <div className="desc">{desc}</div>
                </div>
            </div>

            {/* URL Input */}
            {provider.requiresUrl && (
                <div>
                    <label className="label">Endpoint URL</label>
                    <input type="text" value={config.baseUrl || ""} className="settings-input native"
                        onchange={(e: any) => { config.baseUrl = e.target.value; saveConfig() }} />
                </div>
            )}

            {/* API Key Input */}
            {provider.requiresKey && (
                <div>
                    <label className="label">Active Key</label>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(0,0,0,0.3)", padding: "10px", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.1)" }}>
                        <span className="api-key-display">••••{activeKey?.slice(-6) || "none"}</span>
                        <button className="btn-secondary" onclick={() => {
                            const key = prompt("Enter new API Key")
                            if (key) { config.apiKey = key; saveConfig(); render() }
                        }}>Change</button>
                    </div>
                </div>
            )}

            {/* Validation Output */}
            {validationSlot}

            {/* Extras (only if active for cleanliness, or always?) User wants clean. */}
            {provider.id === "gemini-3" && [
                renderThinkingSlider(config, provider.id),
                renderMediaResolutionControl(config, provider.id)
            ]}
        </div>
    }

    const renderThinkingSlider = (config: any, providerId: string) => {
        const levels = ["minimal", "low", "medium", "high"]
        const current = config.thinkingLevel || "high"
        const idx = levels.indexOf(current)
        return <div className="config-card">
            <label className="label">Thinking Depth: {current.toUpperCase()}</label>
            <input type="range" min="0" max="3" value={idx.toString()}
                onchange={(e: any) => { config.thinkingLevel = levels[parseInt(e.target.value)]; service.ai.setConfig(providerId, config); render() }} />
        </div>
    }

    const renderMediaResolutionControl = (config: any, providerId: string) => {
        const resolutions = ["LOW", "MEDIUM", "HIGH", "ULTRA_HIGH"]
        const current = config.mediaResolution || "ULTRA_HIGH"
        return <div className="config-card">
            <label className="label">Vision Fidelity</label>
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                {resolutions.map(r =>
                    <button
                        className={current === r ? "btn-primary" : "btn-secondary"}
                        style={{ flex: "1", fontSize: "10px" }}
                        onclick={() => { config.mediaResolution = r; service.ai.setConfig(providerId, config); render() }}>
                        {r}
                    </button>
                )}
            </div>
        </div>
    }

    // -- RENDER ENGINE --

    const renderHeader = () => {
        const activeId = service.ai.activeProviderId.getValue()
        const isGemini = activeId === "gemini-3"

        return <div className="header">
            <div className="title-row">
                <span style={{ fontSize: "16px", fontWeight: "700" }}>System Config</span>

                <div className="provider-switch">
                    <div onclick={() => { service.ai.setActiveProvider("gemini-3"); render() }}
                        className={`pill ${isGemini ? 'active' : ''}`}>
                        GEMINI API
                    </div>
                    <div onclick={() => {
                        const local = service.ai.getProviders().find(p => p.id.includes("ollama"))
                        if (local) service.ai.setActiveProvider(local.id);
                        render()
                    }}
                        className={`pill ${!isGemini ? 'active' : ''}`}>
                        LOCAL
                    </div>
                </div>
            </div>
            {!isEmbedded && <button onclick={onBack} style={{ background: "none", border: "none", fontSize: "16px", cursor: "pointer", color: "var(--color-gray)" }}>✕</button>}
        </div> as HTMLElement
    }

    const render = () => {
        container.innerHTML = ""
        container.appendChild(renderHeader())
        container.appendChild(content)

        const footer = <div className="footer">
            <button onclick={async () => {
                if (await Dialogs.approve({ message: "Reset Odie Wizard and clear all settings?" })) {
                    service.ai.resetWizard();
                    location.reload()
                }
            }} style={{ color: "var(--color-red)", background: "transparent", border: "none", fontSize: "11px", cursor: "pointer", opacity: 0.7 }}>Reset Wizard</button>
            <button onclick={onBack} className="btn-primary">Done</button>
        </div> as HTMLElement

        container.appendChild(footer)

        // Render Active Content
        content.innerHTML = ""
        const id = service.ai.activeProviderId.getValue()
        if (id === "gemini-3") {
            content.appendChild(ConfigCard({ providerId: id }))
        } else if (id.includes("ollama")) {
            content.appendChild(ConfigCard({ providerId: id, overrides: { title: "Ollama (Local)", desc: "Private and offline execution." } }))
        } else {
            content.appendChild(ConfigCard({ providerId: id }))
        }
    }

    render()
    return container
}
