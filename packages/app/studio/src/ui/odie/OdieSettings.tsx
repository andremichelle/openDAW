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
                    background: "currentColor", opacity: "0.8"
                }} />
                <div style={{ flex: "1", wordBreak: "break-word" }}>
                    {status === 'checking' ? "Verifying connection..." : displayMessage}
                </div>
            </div>
        )
    }

    // -- KEY RING EDITOR --
    const KeyRingEditor = ({ config, provider, save }: { config: any, provider: any, save: () => void }) => {
        const keyLibrary: string[] = config.keyLibrary || []
        if (keyLibrary.length === 0 && config.apiKey) keyLibrary.push(config.apiKey)
        const statuses = provider.getKeyStatuses ? provider.getKeyStatuses() : keyLibrary.map((k, i) => ({ key: '•••' + k.slice(-4), status: 'unknown', isActive: i === 0 }))

        return <div className="input-row" style={{ alignItems: "flex-start" }}>
            <label className="label" style={{ marginTop: "8px" }}>Infinity Keys</label>
            <div style={{ flex: "1" }}>
                <div className="key-ring-list">
                    {keyLibrary.map((key, idx) => {
                        const info = (statuses as any)[idx] || { key: '????', status: 'unknown', isActive: false }
                        const isExhausted = info.status === 'exhausted'
                        const isActive = info.isActive

                        return <div style={{
                            display: "flex", alignItems: "center", padding: "6px 12px",
                            borderBottom: "1px solid rgba(255,255,255,0.05)",
                            background: isActive ? "rgba(var(--color-accent-rgb), 0.1)" : "transparent",
                            opacity: isExhausted ? "0.5" : "1"
                        }}>
                            <div style={{ width: "6px", height: "6px", borderRadius: "50%", marginRight: "10px", background: isExhausted ? "red" : (isActive ? "var(--accent)" : "#666") }} />
                            <div style={{ flex: "1", fontFamily: "monospace", fontSize: "10px", letterSpacing: "1px", color: isExhausted ? "#888" : "#eee" }}>
                                {info.key || '••••' + key.slice(-4)}
                            </div>
                            <button className="btn-secondary" style={{ padding: "0 4px", border: "none", background: "none", fontSize: "18px", color: "#666" }} onclick={(e: any) => {
                                e.stopPropagation()
                                if (confirm("Remove this API key?")) {
                                    const newLib = [...keyLibrary]; newLib.splice(idx, 1)
                                    config.keyLibrary = newLib; config.apiKey = newLib[0] || ""; save()
                                }
                            }}>×</button>
                        </div>
                    })}
                    <div style={{ padding: "6px", background: "rgba(255,255,255,0.02)", display: "flex", gap: "6px" }}>
                        <button className="odie-btn" style={{ flex: "1", fontSize: "9px" }} onclick={() => {
                            const newKey = prompt("Enter Gemini API Key:")
                            if (newKey && newKey.trim().length > 10) {
                                if (!config.keyLibrary) config.keyLibrary = []
                                config.keyLibrary.push(newKey.trim())
                                if (config.keyLibrary.length === 1) config.apiKey = newKey.trim()
                                save()
                            }
                        }}>+ Add Key</button>
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" className="odie-btn" style={{ flex: "0.5", fontSize: "9px", textDecoration: "none" }}>Get Key ↗</a>
                    </div>
                </div>
                <div style={{ fontSize: "9px", color: "var(--color-gray)", marginTop: "6px", opacity: "0.6" }}>Odie will rotate keys automatically to avoid rate limits.</div>
            </div>
        </div>
    }

    const ConfigCard = ({ providerId, overrides }: { providerId: string, overrides?: any }) => {
        const provider = service.ai.getProvider(providerId)

        // [ANTIGRAVITY] Robust Fallback: Never show a blank page.
        // If the provider fails to load, we substitute a "Ghost" provider to keep the UI structure intact.
        const safeProvider = provider || {
            id: providerId,
            manifest: { name: "Provider Error", description: "This provider could not be loaded." },
            requiresUrl: false,
            requiresKey: false,
            validate: async () => ({ ok: false, message: "System Error: Provider implementation missing." })
        } as any

        const config = service.ai.getConfig(providerId) || {}
        const title = overrides?.title || safeProvider.manifest.name
        const desc = overrides?.desc || safeProvider.manifest.description
        const validationSlot = <div className="validation-area"></div> as HTMLElement

        // If real provider is missing, show localized error immediately
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
                                <select className="settings-input native" style={{ margin: "0", flex: "1" }} onchange={(e: any) => { config.modelId = (e.target as HTMLSelectElement).value; saveConfig() }}>
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

        return <div className={`config-card ${isActive ? 'active-brain' : ''}`} style={{ border: "none", background: "none", padding: "0" }}>
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
                        <input type="text" value={config.baseUrl || ""} className="settings-input native" style={{ flex: "1", margin: "0" }}
                            onchange={(e: any) => { config.baseUrl = (e.target as HTMLInputElement).value; saveConfig() }} />
                    </div>
                )}

                {safeProvider.requiresKey && (
                    providerId === 'gemini-3' ? (
                        <KeyRingEditor config={config} provider={safeProvider} save={saveConfig} />
                    ) : (
                        <div className="input-row">
                            <label className="label">Active Key</label>
                            <div style={{ display: "flex", flex: "1", justifyContent: "space-between", alignItems: "center", background: "rgba(0,0,0,0.3)", padding: "6px 12px", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.1)" }}>
                                <span className="api-key-display" style={{ fontSize: "11px", border: "none", background: "none", padding: "0" }}>••••{config.apiKey?.slice(-6) || "none"}</span>
                                <button className="btn-secondary" style={{ padding: "2px 8px" }} onclick={() => {
                                    const key = prompt("Enter new API Key")
                                    if (key) { config.apiKey = key; saveConfig() }
                                }}>Swap Key</button>
                            </div>
                        </div>
                    )
                )}

                {validationSlot}

                {/* Only show extra controls if it's the real Gemini provider */}
                {providerId === "gemini-3" && [
                    <div className="divider" />,
                    renderThinkingControl(config, providerId),
                    renderMediaResolutionControl(config, providerId)
                ]}
            </div>
        </div>
    }

    const renderThinkingControl = (config: any, providerId: string) => {
        const levels = ["minimal", "low", "medium", "high"]
        const current = config.thinkingLevel || "high"
        return <div className="input-row">
            <label className="label">Thinking Depth</label>
            <div className="value">
                {levels.map(l => (
                    <button
                        className={current === l ? "odie-btn-primary" : "odie-btn"}
                        style={{ flex: "1", fontSize: "9px", padding: "4px 2px" }}
                        onclick={() => { config.thinkingLevel = l; service.ai.setConfig(providerId, config); render() }}>
                        {l.toUpperCase()}
                    </button>
                ))}
            </div>
        </div>
    }

    const renderMediaResolutionControl = (config: any, providerId: string) => {
        const resolutions = ["LOW", "MEDIUM", "HIGH", "ULTRA"]
        const current = config.mediaResolution || "ULTRA_HIGH"
        return <div className="input-row">
            <label className="label">Vision Fidelity</label>
            <div className="value">
                {resolutions.map(r => {
                    const value = r === "ULTRA" ? "ULTRA_HIGH" : r
                    return <button
                        className={current === value ? "odie-btn-primary" : "odie-btn"}
                        style={{ flex: "1", fontSize: "9px", padding: "4px 2px" }}
                        onclick={() => { config.mediaResolution = value; service.ai.setConfig(providerId, config); render() }}>
                        {r}
                    </button>
                })}
            </div>
        </div>
    }

    // -- RENDER ENGINE --

    const renderHeader = () => {
        const activeId = service.ai.activeProviderId.getValue()
        const isGemini = activeId === "gemini-3"

        return <div className="header">
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
                <div className="switch-info">
                    Odie Brain Switch: Use this to toggle between Cloud and Local processing.
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
            }} style={{ color: "var(--color-red)", background: "transparent", border: "none", fontSize: "11px", cursor: "pointer", opacity: "0.7" }}>Reset Wizard</button>
            <button onclick={onBack} className="btn-primary">Done</button>
        </div> as HTMLElement

        container.appendChild(footer)

        // Render Active Content
        content.innerHTML = ""
        const id = service.ai.activeProviderId.getValue()
        if (id === "gemini-3") {
            const info = <div className="guide-col">
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
                        <div style={{ marginBottom: "16px" }}>
                            <p style={{ margin: "0 0 4px 0", color: "var(--color-bright)" }}><strong>Project Context</strong></p>
                            <p style={{ margin: "0 0 8px 0" }}>Odie transmits the raw project state required for generation. Avoid working with sensitive or confidential information on the Free Tier.</p>
                            <p style={{ margin: "0", fontSize: "11px", fontStyle: "italic" }}>Note: Google disconnects this data from your Account, API Key, and Project before any human review occurs.</p>
                        </div>
                        <div>
                            <p style={{ margin: "0 0 4px 0", color: "var(--color-bright)" }}><strong>Infinity Key Strategy</strong></p>
                            <p style={{ margin: "0" }}>Rotate multiple free keys to multiply your total rate limits for an uninterrupted session.</p>
                        </div>
                    </div>
                </div>
            </div> as HTMLElement

            const config = <div className="config-col">
                {ConfigCard({ providerId: id })}
            </div> as HTMLElement

            const row = <div className="split-row">
                {info}
                {config}
            </div> as HTMLElement

            content.appendChild(row)
        } else if (id.includes("ollama")) {
            // [ANTIGRAVITY] Safe Access: specific block for Local to add Hardware Fit
            // Fallback to a ghost provider if the registry is out of sync to prevent UI crashes
            const realProvider = service.ai.getProvider(id)
            const provider = realProvider || {
                id: id,
                manifest: { name: "Ollama (Local)", description: "Private execution." },
                checkHardwareFit: async () => ({ ok: false, message: "Provider not fully loaded." }),
                validate: async () => ({ ok: false, message: "Provider missing." })
            } as any

            const info = <div className="guide-col">
                <div className="info-guide" style={{ padding: "16px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.05)" }}>
                    <h4 style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#aaa", textTransform: "uppercase", letterSpacing: "0.5px" }}>Privacy & Audio Safety</h4>
                    <div style={{ fontSize: "12px", lineHeight: "1.5", color: "#bbb" }}>
                        <div style={{ marginBottom: "16px" }}>
                            <p style={{ margin: "0 0 4px 0", color: "var(--color-bright)" }}><strong>100% Secure</strong></p>
                            <p style={{ margin: "0" }}>Local models run strictly on your machine. No data leaves your hardware, making this the ideal choice for high-security environments.</p>
                        </div>
                        <div style={{ marginBottom: "16px" }}>
                            <p style={{ margin: "0 0 4px 0", color: "var(--color-bright)" }}><strong>Finding Your Fit</strong></p>
                            <p style={{ margin: "0 0 8px 0" }}>Ollama automatically detects your hardware. If a model is too big for your Graphics Card (GPU), it moves to your slower System Memory (CPU). Run <code>ollama ps</code> in your terminal while Odie is active; if it shows "100% CPU", the model is too heavy for your machine's muscles and will be sluggish.</p>
                            <p style={{ margin: "0", fontSize: "11px", fontStyle: "italic", color: "var(--color-gray)" }}>Goal: Find the largest version that fits entirely on your Graphics Card.</p>
                        </div>
                        <div style={{ marginBottom: "0" }}>
                            <p style={{ margin: "0 0 4px 0", color: "var(--color-bright)" }}><strong>Audio Priority</strong></p>
                            <p style={{ margin: "0 0 8px 0" }}>Odie is a side-car subsystem. While it runs in an isolated process, keeping your model in the <strong>GPU (VRAM)</strong> is the "Elite Standard."</p>
                            <p style={{ margin: "0 0 8px 0" }}>Running AI on your CPU consumes the same "muscles" used for audio math and plugins. If the AI is too heavy, your audio may pop or glitch.</p>
                        </div>
                    </div>
                </div>
            </div> as HTMLElement

            const config = <div className="config-col">
                {ConfigCard({ providerId: id, overrides: { title: "Ollama (Local)", desc: "Private execution." } })}

                <div className="settings-grid" style={{ marginTop: "12px" }}>
                    <div className="input-row">
                        <label className="label">Hardware Fit</label>
                        <div style={{ flex: "1", display: "flex", alignItems: "center", gap: "12px", background: "rgba(255,255,255,0.02)", padding: "8px 12px", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.05)" }}>
                            <span id="hardware-fit-msg" style={{ flex: "1", fontSize: "11px", color: "var(--color-gray)" }}>Detecting VRAM vs CPU...</span>
                            <button className="odie-btn" style={{ fontSize: "10px" }}
                                disabled={!realProvider || !realProvider.checkHardwareFit}
                                onclick={async (e: any) => {
                                    const btn = e.currentTarget as HTMLButtonElement;
                                    const originalText = btn.innerText;
                                    btn.innerText = "Testing...";
                                    btn.disabled = true;

                                    try {
                                        if (provider.checkHardwareFit) {
                                            const status = await provider.checkHardwareFit();
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
                        <a href="https://ollama.com/download" target="_blank" style={{ color: "var(--color-blue)", textDecoration: "none", fontWeight: "600" }}>Get Ollama ↗</a>
                    </div>
                </div>
            </div> as HTMLElement

            const row = <div className="split-row">
                {info}
                {config}
            </div> as HTMLElement

            content.appendChild(row)
        } else {
            content.appendChild(ConfigCard({ providerId: id }))
        }
    }

    render()
    return container
}
