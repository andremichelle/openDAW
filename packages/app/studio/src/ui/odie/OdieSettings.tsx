import css from "./OdieSettings.sass?inline"
import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { Html } from "@opendaw/lib-dom"
import { Dialogs } from "@/ui/components/dialogs"
import { Terminator } from "@opendaw/lib-std"
import { LLMProvider, ProviderConfig } from "./services/llm/LLMProvider"

const className = Html.adoptStyleSheet(css, "OdieSettings")

interface OdieSettingsProps {
    service: OdieService
    lifecycle: Terminator
    onBack: () => void
    isEmbedded?: boolean
}

interface ConnectionStatusProps {
    status: 'idle' | 'checking' | 'success' | 'error'
    message: string
}

const ConnectionStatus = ({ status, message }: ConnectionStatusProps) => {
    const displayMessage = message.length > 200 ? message.slice(0, 200) + "..." : message

    return (
        <div className={`connection-status ${status}`}>
            <div className="status-dot" />
            <div style={{ flex: "1", wordBreak: "break-word" }}>
                {status === 'checking' ? "Verifying connection..." : displayMessage}
            </div>
        </div>
    )
}

interface KeyRingEditorProps {
    config: ProviderConfig
    provider: LLMProvider & { getKeyStatuses?: () => { key: string, status: string, isActive: boolean }[] }
    save: () => void
}

const KeyRingEditor = ({ config, provider, save }: KeyRingEditorProps) => {
    const keyLibrary: string[] = config.keyLibrary || []
    if (keyLibrary.length === 0 && config.apiKey) keyLibrary.push(config.apiKey)

    const statuses = provider.getKeyStatuses
        ? provider.getKeyStatuses()
        : keyLibrary.map((k, i) => ({
            key: '•••' + k.slice(-4),
            status: 'unknown',
            isActive: i === 0
        }))

    const removeKey = (idx: number, e: Event) => {
        e.stopPropagation()
        if (confirm("Remove this API key?")) {
            const newLib = [...keyLibrary]
            newLib.splice(idx, 1)
            config.keyLibrary = newLib
            config.apiKey = newLib[0] || ""
            save()
        }
    }

    const addNewKey = () => {
        const newKey = prompt("Enter Gemini API Key:")
        if (newKey && newKey.trim().length > 10) {
            if (!config.keyLibrary) config.keyLibrary = []
            config.keyLibrary.push(newKey.trim())
            if (config.keyLibrary.length === 1) config.apiKey = newKey.trim()
            save()
        }
    }

    return (
        <div className="input-row" style={{ alignItems: "flex-start" }}>
            <label className="label" style={{ marginTop: "8px" }}>API Keys</label>
            <div style={{ flex: "1" }}>
                <div className="key-ring-list">
                    {keyLibrary.map((key, idx) => {
                        const info = statuses[idx] || { key: '????', status: 'unknown', isActive: false }
                        const isExhausted = info.status === 'exhausted'

                        return (
                            <div className={`key-ring-item ${info.isActive ? 'active' : ''} ${isExhausted ? 'exhausted' : ''}`}>
                                <div className={`key-dot ${info.isActive ? 'active' : ''} ${isExhausted ? 'exhausted' : ''}`} />
                                <div className={`key-text ${isExhausted ? 'exhausted' : ''}`}>
                                    {info.key || '••••' + key.slice(-4)}
                                </div>
                                <button
                                    className="remove-key-btn"
                                    onclick={(e: Event) => removeKey(idx, e)}
                                >×</button>
                            </div>
                        )
                    })}
                    <div style={{ padding: "6px", background: "rgba(255,255,255,0.02)", display: "flex", gap: "6px" }}>
                        <button className="odie-btn" style={{ flex: "1", fontSize: "9px" }} onclick={addNewKey}>+ Add Key</button>
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="odie-btn" style={{ flex: "0.5", fontSize: "9px", textDecoration: "none" }}>Get Key ↗</a>
                    </div>
                </div>
                <div style={{ fontSize: "9px", color: "var(--color-gray)", marginTop: "6px", opacity: "0.6" }}>Keys are used to avoid rate limits.</div>
            </div>
        </div>
    )
}

export const OdieSettings = ({ service, lifecycle: _lifecycle, onBack, isEmbedded = false }: OdieSettingsProps) => {

    const container = <div className={Html.buildClassList(className, "component", isEmbedded && "embedded")}></div> as HTMLElement
    const content = <div className="main"></div> as HTMLElement

    const ConfigCard = ({ providerId, overrides }: { providerId: string, overrides?: { title?: string, desc?: string } }) => {
        const provider = service.ai.getProvider(providerId)

        const safeProvider = provider || {
            id: providerId,
            manifest: { name: "Provider Error", description: "This provider could not be loaded." },
            requiresUrl: false,
            requiresKey: false,
            validate: async () => ({ ok: false, message: "System Error: Provider implementation missing." })
        } as unknown as LLMProvider

        const config = service.ai.getConfig(providerId) || {}
        const title = overrides?.title || safeProvider.manifest.name
        const desc = overrides?.desc || safeProvider.manifest.description
        const validationSlot = <div className="validation-area"></div> as HTMLElement

        if (!provider) {
            validationSlot.appendChild(ConnectionStatus({ status: 'error', message: "System Warning: Provider not found in registry." }))
        }

        const saveConfig = () => {
            const lib = config.keyLibrary || []
            if (lib.length > 0) config.apiKey = lib[0]
            service.ai.setConfig(providerId, { ...config })
            render()
        }

        const runValidation = async (tempKey?: string, tempUrl?: string) => {
            validationSlot.innerHTML = ""
            validationSlot.appendChild(ConnectionStatus({ status: 'checking', message: "" }))
            const newConfig = { ...config }
            if (tempKey !== undefined) newConfig.apiKey = tempKey
            if (tempUrl !== undefined) newConfig.baseUrl = tempUrl
            service.ai.setConfig(providerId, newConfig)

            if (safeProvider.validate) {
                const res = await safeProvider.validate()
                validationSlot.innerHTML = ""
                validationSlot.appendChild(ConnectionStatus({ status: res.ok ? 'success' : 'error', message: res.message }))

                if (res.ok && safeProvider.fetchModels) {
                    const models = await safeProvider.fetchModels()
                    if (models.length > 0) {
                        validationSlot.appendChild(
                            <div className="input-row" style={{ marginTop: "12px" }}>
                                <label className="label">Active Model</label>
                                <select
                                    className="settings-input native"
                                    style={{ margin: "0", flex: "1" }}
                                    onchange={(e: Event) => {
                                        config.modelId = (e.target as HTMLSelectElement).value;
                                        saveConfig()
                                    }}
                                >
                                    {models.map((m: string) => <option value={m} selected={m === config.modelId}>{m}</option>)}
                                </select>
                            </div>
                        )
                    }
                }
            }
        }

        if (!isEmbedded && provider) setTimeout(() => runValidation(), 0)
        const isActive = service.ai.activeProviderId.getValue() === providerId

        return (
            <div className={`config-card ${isActive ? 'active-provider' : ''}`} style={{ border: "none", background: "none", padding: "0" }}>
                <div className="provider-header">
                    <div className="info">
                        <h3>{title}</h3>
                        <div className="desc">{desc}</div>
                    </div>
                    <button className="odie-btn" onclick={() => runValidation()}>Test Connection</button>
                </div>

                <div className="settings-grid">
                    {safeProvider.requiresUrl && (
                        <div className="input-row">
                            <label className="label">Endpoint URL</label>
                            <input
                                type="text"
                                value={config.baseUrl || ""}
                                className="settings-input native"
                                style={{ flex: "1", margin: "0" }}
                                onchange={(e: Event) => {
                                    config.baseUrl = (e.target as HTMLInputElement).value;
                                    saveConfig()
                                }}
                            />
                        </div>
                    )}

                    {safeProvider.requiresKey && (
                        providerId === 'gemini-3' ? (
                            <KeyRingEditor config={config} provider={safeProvider} save={saveConfig} />
                        ) : (
                            <div className="input-row">
                                <label className="label">Active Key</label>
                                <div className="active-key-display">
                                    <span className="api-key-display">••••{config.apiKey?.slice(-6) || "none"}</span>
                                    <button className="btn-secondary" style={{ padding: "2px 8px" }} onclick={() => {
                                        const key = prompt("Enter new API Key")
                                        if (key) { config.apiKey = key; saveConfig() }
                                    }}>Swap Key</button>
                                </div>
                            </div>
                        )
                    )}

                    {validationSlot}

                    {providerId === "gemini-3" && [
                        <div className="divider" />,
                        renderThinkingControl(config, providerId),
                        renderMediaResolutionControl(config, providerId)
                    ]}
                </div>
            </div>
        )
    }

    const renderThinkingControl = (config: ProviderConfig, providerId: string) => {
        const levels = ["minimal", "low", "medium", "high"] as const
        const current = config.thinkingLevel || "high"
        return (
            <div className="input-row">
                <label className="label">Thinking Depth</label>
                <div className="value">
                    {levels.map(l => (
                        <button
                            className={current === l ? "odie-btn-primary" : "odie-btn"}
                            style={{ flex: "1", fontSize: "9px", padding: "4px 2px" }}
                            onclick={() => { service.ai.setConfig(providerId, { ...config, thinkingLevel: l }); render() }}>
                            {l.toUpperCase()}
                        </button>
                    ))}
                </div>
            </div>
        )
    }

    const renderMediaResolutionControl = (config: ProviderConfig, providerId: string) => {
        const resolutions = ["LOW", "MEDIUM", "HIGH", "ULTRA"]
        const current = config.mediaResolution || "ULTRA_HIGH"
        return (
            <div className="input-row">
                <label className="label">Vision Fidelity</label>
                <div className="value">
                    {resolutions.map(r => {
                        const value = r === "ULTRA" ? "ULTRA_HIGH" : r
                        return (
                            <button
                                className={current === value ? "odie-btn-primary" : "odie-btn"}
                                style={{ flex: "1", fontSize: "9px", padding: "4px 2px" }}
                                onclick={() => { service.ai.setConfig(providerId, { ...config, mediaResolution: value as any }); render() }}>
                                {r}
                            </button>
                        )
                    })}
                </div>
            </div>
        )
    }

    const renderHeader = () => {
        const activeId = service.ai.activeProviderId.getValue()
        const isGemini = activeId === "gemini-3"

        return (
            <div className="header">
                <div className="title-row">
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
                {!isEmbedded && (
                    <button
                        onclick={onBack}
                        style={{ background: "none", border: "none", fontSize: "16px", cursor: "pointer", color: "var(--color-gray)" }}
                    >✕</button>
                )}
            </div>
        ) as HTMLElement
    }

    const render = () => {
        container.innerHTML = ""
        container.appendChild(renderHeader())
        container.appendChild(content)

        const footer = (
            <div className="footer">
                <button onclick={async () => {
                    if (await Dialogs.approve({ message: "Reset Odie Wizard and clear all settings?" })) {
                        service.ai.resetWizard();
                        location.reload()
                    }
                }} style={{ color: "var(--color-red)", background: "transparent", border: "none", fontSize: "11px", cursor: "pointer", opacity: "0.7" }}>Reset Wizard</button>
                <button onclick={onBack} className="btn-primary">Done</button>
            </div>
        ) as HTMLElement

        container.appendChild(footer)

        content.innerHTML = ""
        const id = service.ai.activeProviderId.getValue()

        if (id === "gemini-3") {
            const info = (
                <div className="guide-col">
                    <div className="info-guide" style={{ padding: "16px", background: "rgba(var(--color-accent-rgb), 0.05)", borderRadius: "8px", border: "1px solid rgba(var(--color-accent-rgb), 0.1)" }}>
                        <h4 style={{ margin: "0 0 12px 0", fontSize: "14px", color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Privacy & Data Usage</h4>
                        <div style={{ fontSize: "12px", lineHeight: "1.5", color: "#ccc" }}>
                            <div style={{ marginBottom: "16px" }}>
                                <p style={{ margin: "0 0 4px 0", color: "var(--color-bright)" }}><strong>Free vs Paid Policies</strong></p>
                                <ul style={{ margin: "0", paddingLeft: "18px" }}>
                                    <li style={{ marginBottom: "8px" }}><strong>Free Tier:</strong> Data is shared with Google to improve models and may be viewed by human reviewers.</li>
                                    <li><strong>Paid Tier:</strong> Data is strictly private and never used by Google for training.</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            ) as HTMLElement

            const config = <div className="config-col">{ConfigCard({ providerId: id })}</div> as HTMLElement
            const row = <div className="split-row">{info}{config}</div> as HTMLElement
            content.appendChild(row)

        } else if (id.includes("ollama")) {
            const realProvider = service.ai.getProvider(id)

            const info = (
                <div className="guide-col">
                    <div className="info-guide" style={{ padding: "16px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.05)" }}>
                        <h4 style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#aaa", textTransform: "uppercase", letterSpacing: "0.5px" }}>Privacy & Audio Safety</h4>
                        <div style={{ fontSize: "12px", lineHeight: "1.5", color: "#bbb" }}>
                            <p style={{ margin: "0 0 8px 0" }}>Local models run strictly on your machine. No data leaves your hardware.</p>
                            <p style={{ margin: "0 0 8px 0" }}>Running AI on your CPU uses resources needed for audio processing. If the AI is too heavy, your audio may pop or glitch.</p>
                        </div>
                    </div>
                </div>
            ) as HTMLElement

            const config = (
                <div className="config-col">
                    {ConfigCard({ providerId: id, overrides: { title: "Ollama (Local)", desc: "Private execution." } })}

                    <div className="settings-grid" style={{ marginTop: "12px" }}>
                        <div className="input-row">
                            <label className="label">Hardware Fit</label>
                            <div style={{ flex: "1", display: "flex", alignItems: "center", gap: "12px", background: "rgba(255,255,255,0.02)", padding: "8px 12px", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.05)" }}>
                                <span id="hardware-fit-msg" style={{ flex: "1", fontSize: "11px", color: "var(--color-gray)" }}>Detecting VRAM vs CPU...</span>
                                <button className="odie-btn" style={{ fontSize: "10px" }}
                                    disabled={!realProvider || !realProvider.checkHardwareFit}
                                    onclick={async (e: Event) => {
                                        const btn = e.currentTarget as HTMLButtonElement;
                                        const originalText = btn.innerText;
                                        btn.innerText = "Testing...";
                                        btn.disabled = true;

                                        try {
                                            if (realProvider?.checkHardwareFit) {
                                                const status = await realProvider.checkHardwareFit();
                                                const color = status.ok ? "var(--color-green)" : (status.data?.cpu === 100 ? "var(--color-red)" : "var(--color-orange)");
                                                const display = document.getElementById('hardware-fit-msg');
                                                if (display) {
                                                    display.innerText = status.message;
                                                    display.style.color = color;
                                                }
                                            } else {
                                                const display = document.getElementById('hardware-fit-msg');
                                                if (display) display.innerText = "Feature not supported.";
                                            }
                                        } finally {
                                            btn.innerText = originalText;
                                            btn.disabled = false;
                                        }
                                    }}>Test Fit</button>
                            </div>
                        </div>

                        <div className="divider" />

                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "10px" }}>
                            <div style={{ color: "var(--color-gray)" }}>Standard: <strong style={{ color: "var(--color-bright)" }}>Qwen 2.5 Coder</strong></div>
                            <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" style={{ color: "var(--color-blue)", textDecoration: "none", fontWeight: "600" }}>Get Ollama ↗</a>
                        </div>
                    </div>
                </div>
            ) as HTMLElement

            const row = <div className="split-row">{info}{config}</div> as HTMLElement
            content.appendChild(row)
        } else {
            content.appendChild(ConfigCard({ providerId: id }))
        }
    }

    render()
    return container
}

