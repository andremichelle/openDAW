import css from "./OdieSetup.sass?inline"
import { createElement } from "@opendaw/lib-jsx"
import { Html } from "@opendaw/lib-dom"
import { Lifecycle, DefaultObservableValue, Terminator } from "@opendaw/lib-std"
import { OdieService } from "../OdieService"
import { userService, UserLevel } from "../services/UserService"
import { Button } from "@/ui/components/Button"
import { TextInput } from "@/ui/components/TextInput"
import { Colors } from "@opendaw/studio-enums"

// Adopt Styles
const styles = Html.adoptStyleSheet(css, "OdieSetup")

// --- ICONS (Lucide Style) ---
const IconCloud = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.5 19c0-3.037-2.463-5.5-5.5-5.5S6.5 15.963 6.5 19" /><path d="M19 13.5c0-2.485-2.015-4.5-4.5-4.5S10 11.015 10 13.5" /><path d="M5 19a6 6 0 0 1 6-6 6 6 0 0 1 6 6" /></svg>
)
const IconServer = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" /><line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" /></svg>
)
const IconUser = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
)

const IconEdit = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
)
const IconMic = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="23" /><line x1="8" x2="16" y1="23" y2="23" /></svg>
)
const IconMusic = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
)
const IconSliders = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" x2="4" y1="21" y2="14" /><line x1="4" x2="4" y1="10" y2="3" /><line x1="12" x2="12" y1="21" y2="12" /><line x1="12" x2="12" y1="8" y2="3" /><line x1="20" x2="20" y1="21" y2="16" /><line x1="20" x2="20" y1="12" y2="3" /><line x1="1" x2="7" y1="14" y2="14" /><line x1="9" x2="15" y1="8" y2="8" /><line x1="17" x2="23" y1="16" y2="16" /></svg>
)
const IconTarget = () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>
)

// Helper for dynamic rendering
const ObserverView = (
    lifecycle: Lifecycle,
    observable: DefaultObservableValue<any>,
    renderer: (val: any) => HTMLElement
) => {
    const container = document.createElement("div")

    lifecycle.own(observable.subscribe(val => {
        container.innerHTML = ""
        const content = renderer(val)
        if (content) container.appendChild(content)
    }))

    // Initial render
    const initialVal = observable.getValue()
    if (initialVal !== undefined) {
        const content = renderer(initialVal)
        if (content) container.appendChild(content)
    }

    return container
}

export const OdieSetupView = ({ service }: { service: OdieService }) => {
    const lifecycle = new Terminator()

    // State
    const currentStep = new DefaultObservableValue(1)
    const activeProfileTab = new DefaultObservableValue("identity") // identity | sound | studio | goals
    const manualMode = new DefaultObservableValue(false)

    // AI State
    const selectedProvider = new DefaultObservableValue(service.ai.activeProviderId.getValue() || "gemini")
    const isScanning = new DefaultObservableValue(false)
    const scanStatus = new DefaultObservableValue("") // "Online" | "Error" | ""
    const ollamaModels = new DefaultObservableValue<string[]>([])
    const ollamaGuidance = new DefaultObservableValue("")
    const ollamaErrorType = new DefaultObservableValue<"cors" | "missing" | "none">("none")

    // Profile State
    const userDNA = userService.dna
    const nameModel = new DefaultObservableValue(userDNA.getValue().name || "")

    // Layout: Hide Chat Overlay during Setup
    if (service.studio) {
        service.studio.layout.odieVisible.setValue(false)
    }

    // Actions
    const setProvider = (id: string) => {
        selectedProvider.setValue(id)
        service.ai.setActiveProvider(id)
    }

    const checkOllama = async () => {
        isScanning.setValue(true)
        scanStatus.setValue("Checking...")
        ollamaErrorType.setValue("none")
        const ollama = service.ai.getProvider("ollama")

        if (!ollama) {
            isScanning.setValue(false)
            return
        }

        try {
            const models = (ollama.fetchModels) ? await ollama.fetchModels() : []
            if (models && models.length > 0) {
                ollamaModels.setValue(models)
                scanStatus.setValue("Online")
                // Auto-select first if not set
                service.ai.setConfig("ollama", { modelId: models[0] })
                updateGuidance(models[0])
            } else {
                scanStatus.setValue("Connection Failed")
                ollamaErrorType.setValue("missing") // Or CORS detection logic
            }
        } catch (e: any) {
            console.error(e)
            scanStatus.setValue("Not Found")
            const msg = e.toString()
            if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
                ollamaErrorType.setValue("cors")
            } else {
                ollamaErrorType.setValue("missing")
            }
        } finally {
            isScanning.setValue(false)
        }
    }

    const updateGuidance = (modelId: string) => {
        const isLarge = modelId.toLowerCase().includes("70b") || modelId.toLowerCase().includes("large")
        const isMed = modelId.toLowerCase().includes("14b") || modelId.toLowerCase().includes("32b")
        if (isLarge) ollamaGuidance.setValue("STATUS: High RAM requirement. 64GB+ recommended.")
        else if (isMed) ollamaGuidance.setValue("STATUS: Medium RAM recommended. 32GB recommended.")
        else ollamaGuidance.setValue("STATUS: Optimized for standard computers.")
    }

    const finishSetup = () => {
        userService.update({ name: nameModel.getValue() })
        window.location.hash = "/odie/profile"
    }

    // -- RENDERERS --

    const renderStep1 = () => (
        <div className={`wizard-container ${styles}`}>
            <div style={{ marginBottom: "1rem", borderBottom: "1px solid var(--color-edge)", paddingBottom: "1rem" }}>
                <h1>Select Your AI Engine</h1>
                <p>Choose the intelligence model that powers Odie.</p>
            </div>

            <div className="wizard-grid">
                {/* Cloud Option */}
                {ObserverView(lifecycle, selectedProvider, (current) => (
                    <div
                        className={`wizard-card ${current === "gemini" ? "active" : ""}`}
                        onClick={() => setProvider("gemini")}
                    >
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <div className="card-icon blue"><IconCloud /></div>
                            <h3>Cloud Power</h3>
                            <div className="badge blue">RECOMMENDED</div>
                        </div>
                        <p>Powered by Google Gemini. Fast, smart, and effectively <strong>Infinite</strong>.</p>

                        <div style={{ fontSize: "0.65rem", color: "var(--color-text-3)", padding: "8px", background: "rgba(255,255,255,0.03)", borderRadius: "6px", marginBottom: "1rem", border: "1px solid var(--color-edge)", lineHeight: "1.4" }}>
                            <b>Privacy Note:</b> Free Tier data (outside EEA/UK) is anonymized and used to improve Google products. Use a <b>Paid Key</b> or <b>Local AI</b> for total privacy.
                        </div>

                        {/* Details Panel */}
                        <div style={{ marginTop: "auto" }}>
                            <div className="status-panel" style={{ fontSize: "0.8rem", marginBottom: "1rem" }}>
                                <div style={{ fontSize: "0.7rem", fontWeight: "bold", color: "var(--color-blue-400)", marginBottom: "0.5rem", textTransform: "uppercase" }}>Quick Setup</div>
                                <div style={{ marginBottom: "0.5rem" }}>
                                    1. <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={{ color: "white", textDecoration: "underline" }} onClick={(e: any) => e.stopPropagation()}>Get Free Gemini API Key</a>
                                </div>
                                <div style={{ display: "flex", gap: "0.5rem" }}>
                                    <input
                                        id="gemini-key-input"
                                        type="password"
                                        placeholder="Paste API Key..."
                                        className="text-input"
                                        style={{ flex: "1 1 0%", padding: "8px", borderRadius: "6px", border: "1px solid var(--color-edge)", background: "var(--color-bg-3)", color: "white", fontSize: "12px" }}
                                        onClick={(e: any) => e.stopPropagation()}
                                        onChange={(e: any) => {
                                            const key = e.target.value
                                            service.ai.setConfig("gemini", { apiKey: key })
                                        }}
                                        value={service.ai.getConfig("gemini")?.apiKey || ""}
                                    />
                                </div>
                                <div style={{ fontSize: "0.7rem", color: "var(--color-text-3)", marginTop: "0.5rem", lineHeight: "1.3" }}>
                                    <b>Privacy Note:</b> Free Tier data is used by Google to improve products. Use a Paid Key for enterprise privacy.
                                </div>
                            </div>
                            <Button lifecycle={lifecycle} onClick={(e: any) => {
                                e.stopPropagation();
                                const key = (document.getElementById("gemini-key-input") as HTMLInputElement)?.value;
                                if (!key && !service.ai.getConfig("gemini")?.apiKey) {
                                    alert("Please enter an API Key to proceed.");
                                    return;
                                }
                                currentStep.setValue(2);
                            }} appearance={{ framed: true }} style={{ width: "100%", backgroundColor: "var(--color-blue-600)" }}>
                                Next: Introduction
                            </Button>
                        </div>
                    </div>
                ))}

                {/* Local Option */}
                {ObserverView(lifecycle, selectedProvider, (current) => (
                    <div
                        className={`wizard-card ${current === "ollama" ? "active" : ""}`}
                        onClick={() => setProvider("ollama")}
                    >
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <div className="card-icon green"><IconServer /></div>
                            <h3>Local Brain</h3>
                        </div>
                        <p>Ollama execution. <strong>100% private</strong>. Runs on your hardware.</p>

                        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
                            <div className="status-panel">
                                <div className="row">
                                    <span className="label">Status</span>
                                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                        {ObserverView(lifecycle, scanStatus, (s) => (
                                            <span style={{
                                                fontSize: "0.8rem", fontWeight: "bold",
                                                color: s === "Online" ? "var(--color-green-500)" : (s.includes("Fail") ? "var(--color-red-500)" : "var(--color-orange-500)")
                                            }}>{s}</span>
                                        ))}
                                        <Button lifecycle={lifecycle} onClick={(e: any) => { e.stopPropagation(); checkOllama() }} appearance={{ framed: false }} style={{ padding: "2px 6px", fontSize: "10px" }}>Scan</Button>
                                    </div>
                                </div>

                                {/* Model Selector */}
                                {ObserverView(lifecycle, ollamaModels, (models: string[]) => {
                                    if (models.length === 0) return (
                                        <div style={{ marginTop: "0.5rem" }}>
                                            <a href="https://ollama.com/download" target="_blank" rel="noopener noreferrer" style={{ fontSize: "0.75rem", color: "var(--color-blue-400)", display: "flex", alignItems: "center", gap: "4px" }} onClick={(e: any) => e.stopPropagation()}>
                                                Download Ollama
                                            </a>
                                        </div>
                                    )
                                    return (
                                        <div onClick={(e: any) => e.stopPropagation()} style={{ marginTop: "0.5rem" }}>
                                            <select
                                                onChange={(e: any) => {
                                                    service.ai.setConfig("ollama", { modelId: e.target.value })
                                                    updateGuidance(e.target.value)
                                                }}
                                                value={service.ai.getConfig("ollama")?.modelId || models[0]}
                                                style={{ width: "100%", padding: "6px", borderRadius: "4px", background: "var(--color-bg-3)", color: "white", border: "1px solid var(--color-edge)", fontSize: "12px" }}
                                            >
                                                {models.map((m: string) => <option value={m}>{m}</option>)}
                                            </select>
                                            {ObserverView(lifecycle, ollamaGuidance, (g) => <div style={{ fontSize: "10px", marginTop: "4px", lineHeight: "1.4", opacity: "0.8" }} innerHTML={g}></div>)}
                                        </div>
                                    )
                                })}

                                {/* Errors */}
                                {ObserverView(lifecycle, ollamaErrorType, (type) => {
                                    if (type === "cors") return <div style={{ color: "var(--color-red-500)", fontSize: "0.75rem", marginTop: "0.5rem", padding: "6px", background: "rgba(239,68,68,0.1)", borderRadius: "4px" }}><b>BLOCKED</b>: Browser security.<br />Set env var: <code>OLLAMA_ORIGINS="*"</code></div>
                                    if (type === "missing") return (
                                        <div style={{ color: "var(--color-orange-500)", fontSize: "0.75rem", marginTop: "0.5rem" }}>
                                            MISSING BRAIN. Run in terminal:
                                            <div style={{ background: "rgba(0,0,0,0.3)", padding: "4px", borderRadius: "4px", fontFamily: "monospace", marginTop: "2px", userSelect: "all" }}>ollama run qwen3-coder:7b</div>
                                        </div>
                                    )
                                    return null
                                })}
                            </div>

                            <div style={{ fontSize: "0.7rem", color: "var(--color-green-400)", padding: "8px", background: "rgba(16, 185, 129, 0.1)", borderRadius: "6px", border: "1px solid rgba(16, 185, 129, 0.2)" }}>
                                <b>DAW Safety Verified</b>: Odie runs on a separate process path. Your audio engine is always priority #1.
                            </div>

                            <div style={{ borderTop: "1px solid var(--color-edge)", paddingTop: "0.5rem" }}>
                                <div style={{ fontSize: "0.7rem", fontWeight: "bold", color: "var(--color-text-3)", marginBottom: "0.5rem", textTransform: "uppercase" }}>Elite Recommendations</div>
                                <div style={{ fontSize: "0.65rem", display: "flex", flexDirection: "column", gap: "4px", color: "var(--color-text-2)" }}>
                                    <div>• <b>Speed:</b> Qwen3-Coder 7B <span style={{ color: "var(--color-text-3)" }}>(8-16GB RAM)</span></div>
                                    <div>• <b>Balance:</b> Qwen3-Coder 14B <span style={{ color: "var(--color-text-3)" }}>(32GB RAM)</span></div>
                                    <div>• <b>Advanced:</b> Qwen3-Coder 32B <span style={{ color: "var(--color-text-3)" }}>(64GB+ RAM)</span></div>
                                </div>
                            </div>

                            {ObserverView(lifecycle, scanStatus, (s) => (
                                <Button lifecycle={lifecycle}
                                    onClick={(e) => { e.stopPropagation(); currentStep.setValue(2); }}
                                    appearance={{ color: Colors.green }}
                                    style={{ width: "100%", opacity: s === "Online" ? "1" : "0.5", pointerEvents: s === "Online" ? "auto" : "none" }}>
                                    Next: Introduction
                                </Button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )

    const renderStep2 = () => (
        <div className={`wizard-container ${styles}`}>
            <div style={{ marginBottom: "1rem", borderBottom: "1px solid var(--color-edge)", paddingBottom: "1rem" }}>
                <h1>System Online.</h1>
                <p>I am Odie, your AI co-producer.</p>
            </div>

            <div className="wizard-grid three-col" style={{ marginBottom: "2rem" }}>
                {[
                    { icon: <IconSliders />, title: "The Operator", desc: "Control the studio.", examples: ["Set BPM to 128", "Export mixdown"] },
                    { icon: <IconMusic />, title: "The Creative", desc: "Musical collaborator.", examples: ["Give me chord ideas", "Write lyrics"] }
                ].map((card: any) => (
                    <div className="wizard-card">
                        <div className="card-icon">{card.icon}</div>
                        <h3>{card.title}</h3>
                        <p>{card.desc}</p>
                        <ul style={{ fontSize: "0.8rem", color: "var(--color-text-3)", paddingLeft: "1rem", margin: "0", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                            {card.examples.map((e: string) => <li>"{e}"</li>)}
                        </ul>
                    </div>
                ))}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem" }}>
                <Button lifecycle={lifecycle} onClick={() => currentStep.setValue(1)} appearance={{ framed: false }}>
                    Back
                </Button>
                <Button lifecycle={lifecycle} onClick={() => currentStep.setValue(3)} appearance={{ framed: true }} style={{ backgroundColor: "var(--color-blue-600)" }}>
                    Start Setup
                </Button>
            </div>
        </div>
    )

    const renderStep3 = () => (
        <div className={`wizard-container ${styles}`} style={{ height: "100%" }}>
            {ObserverView(lifecycle, manualMode, (isManual) => {
                if (!isManual) {
                    // --- CHOICE MODE (SIMPLE) ---
                    return (
                        <div style={{ maxWidth: "500px", margin: "0 auto", width: "100%", padding: "20px 0" }}>
                            <div style={{ textAlign: "center", marginBottom: "2rem" }}>
                                <h1>Profile Setup</h1>
                                <p>How do you want to start?</p>
                            </div>

                            <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                                <div className="form-group">
                                    <label>My Name Is</label>
                                    <TextInput lifecycle={lifecycle} model={nameModel} />
                                </div>

                                <Button lifecycle={lifecycle}
                                    onClick={() => {
                                        if (nameModel.getValue()) finishSetup()
                                    }}
                                    appearance={{ color: Colors.blue }}
                                    style={{ width: "100%", height: "48px", fontSize: "14px" }}>
                                    Quick Start (Skip Details)
                                </Button>

                                <div style={{ width: "100%", borderTop: "1px solid var(--color-edge)", paddingTop: "1.5rem" }}>
                                    <div style={{ textAlign: "center", marginBottom: "1rem" }}>
                                        <div style={{ fontSize: "0.7rem", fontWeight: "bold", textTransform: "uppercase", color: "var(--color-text-2)" }}>Advanced Setup</div>
                                    </div>

                                    <div className="wizard-grid">
                                        <div className="wizard-card" onClick={() => manualMode.setValue(true)}>
                                            <div className="card-icon blue"><IconEdit /></div>
                                            <h3>Edit Profile</h3>
                                            <p style={{ fontSize: "0.75rem", margin: "0" }}>Manual Config</p>
                                        </div>
                                        <div className="wizard-card" onClick={() => {
                                            if (!nameModel.getValue()) return alert("Please enter your name first.")
                                            finishSetup()
                                            setTimeout(() => service.sendMessage("Hi Odie. I'm ready to set up my profile. Please interview me."), 500)
                                        }}>
                                            <div className="card-icon purple"><IconMic /></div>
                                            <h3>Interview</h3>
                                            <p style={{ fontSize: "0.75rem", margin: "0" }}>Chat Mode</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )
                } else {
                    // --- PROFILE EDITOR (MANUAL MODE - FLATTENED) ---

                    const renderTabBtn = (id: string, label: string, icon: any) => {
                        return ObserverView(lifecycle, activeProfileTab, (current) => (
                            <div
                                className={`tab ${current === id ? "active" : ""}`}
                                onClick={() => activeProfileTab.setValue(id)}
                                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                            >
                                <div style={{ transform: "scale(0.8)", opacity: current === id ? "1" : "0.5" }}>{icon}</div>
                                <span>{label}</span>
                            </div>
                        ))
                    }

                    return (
                        <div className="profile-editor">
                            {/* HEADER & TABS */}
                            <div>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                                    <h2 style={{ margin: "0" }}>Complete Your Profile</h2>
                                    <Button lifecycle={lifecycle} onClick={() => manualMode.setValue(false)} appearance={{ framed: false }}>Back</Button>
                                </div>
                                <div className="tabs">
                                    {renderTabBtn("identity", "Identity", <IconUser />)}
                                    {renderTabBtn("sound", "Sound", <IconMusic />)}
                                    {renderTabBtn("studio", "Studio", <IconSliders />)}
                                    {renderTabBtn("goals", "Goals", <IconTarget />)}
                                </div>
                            </div>

                            {/* FORM AREA */}
                            <div style={{ flex: "1", overflowY: "auto", paddingBottom: "2rem" }}>
                                {(() => {
                                    const combined = new DefaultObservableValue({ tab: activeProfileTab.getValue(), dna: userService.dna.getValue() })
                                    lifecycle.own(activeProfileTab.subscribe(obs => combined.setValue({ tab: obs.getValue(), dna: userService.dna.getValue() })))
                                    lifecycle.own(userService.dna.subscribe(obs => combined.setValue({ tab: activeProfileTab.getValue(), dna: obs.getValue() })))

                                    return ObserverView(lifecycle, combined, ({ tab, dna }) => {
                                        if (tab === "identity") return (
                                            <div style={{ maxWidth: "600px" }}>
                                                <div className="form-group">
                                                    <label>Name / Alias</label>
                                                    <TextInput lifecycle={lifecycle} model={nameModel} />
                                                </div>

                                                <div className="form-group">
                                                    <label>Experience Level</label>
                                                    <div className="level-selector">
                                                        {["beginner", "intermediate", "advanced", "pro"].map(l => (
                                                            <div
                                                                className={`level-btn ${dna.level === l ? "active" : ""}`}
                                                                onClick={() => { userService.update({ level: l as UserLevel }); activeProfileTab.setValue("identity"); }}
                                                            >
                                                                {l.charAt(0).toUpperCase() + l.slice(1)}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>

                                                <div className="form-group">
                                                    <label>Role</label>
                                                    <select
                                                        onChange={(e: any) => userService.update({ identity: { ...dna.identity, role: e.target.value as any } })}
                                                        value={dna.identity.role}
                                                    >
                                                        {["producer", "songwriter", "mixer", "sound_designer", "artist"].map(r =>
                                                            <option value={r}>{r.toUpperCase().replace("_", " ")}</option>
                                                        )}
                                                    </select>
                                                </div>

                                                <div className="form-group">
                                                    <label>Location</label>
                                                    <input type="text"
                                                        value={dna.identity.location}
                                                        onChange={(e: any) => userService.update({ identity: { ...dna.identity, location: e.target.value } })}
                                                        placeholder="Where are you based?"
                                                        style={{ width: "100%", padding: "8px", background: "var(--color-bg-3)", border: "1px solid var(--color-edge)", color: "white", borderRadius: "4px" }}
                                                    />
                                                </div>
                                            </div>
                                        )
                                        // ... Simpler logic for other tabs ...
                                        if (tab === "sound") return (
                                            <div style={{ maxWidth: "600px" }}>
                                                <div className="form-group">
                                                    <label>Primary Genre</label>
                                                    <input type="text" value={dna.sonicFingerprint.primaryGenre}
                                                        placeholder="e.g. Melodic Techno"
                                                        onChange={(e: any) => userService.update({ sonicFingerprint: { ...dna.sonicFingerprint, primaryGenre: e.target.value } })}
                                                    />
                                                </div>
                                                <div className="form-group">
                                                    <label>Secondary Genres</label>
                                                    <input type="text" value={dna.sonicFingerprint.secondaryGenres.join(", ")}
                                                        placeholder="e.g. Bass Music, Ambient"
                                                        onChange={(e: any) => userService.update({ sonicFingerprint: { ...dna.sonicFingerprint, secondaryGenres: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) } })}
                                                    />
                                                </div>
                                                <div className="form-group">
                                                    <label>Vibe Keywords</label>
                                                    <input type="text" value={dna.sonicFingerprint.vibeKeywords.join(", ")}
                                                        placeholder="Use comma separated list..."
                                                        onChange={(e: any) => userService.update({ sonicFingerprint: { ...dna.sonicFingerprint, vibeKeywords: e.target.value.split(",").map((s: string) => s.trim()) } })}
                                                    />
                                                </div>
                                                <div className="form-group">
                                                    <label>Key Influences</label>
                                                    <input type="text" value={dna.influences.join(", ")}
                                                        placeholder="Daft Punk, Hans Zimmer..."
                                                        onChange={(e: any) => userService.update({ influences: e.target.value.split(",").map((s: string) => s.trim()) })}
                                                        style={{ width: "100%", padding: "8px", background: "var(--color-bg-3)", border: "1px solid var(--color-edge)", color: "white", borderRadius: "4px" }}
                                                    />
                                                </div>
                                            </div>
                                        )
                                        if (tab === "studio") return (
                                            <div style={{ maxWidth: "600px" }}>
                                                <div className="form-group">
                                                    <label>Workflow Preference</label>
                                                    <select
                                                        onChange={(e: any) => userService.update({ techRider: { ...dna.techRider, workflow: e.target.value as any } })}
                                                        value={dna.techRider.workflow}
                                                    >
                                                        <option value="in-the-box">Software Only</option>
                                                        <option value="hybrid">Hybrid</option>
                                                        <option value="outboard-heavy">Analog Heavy</option>
                                                    </select>
                                                </div>
                                                <div className="form-group">
                                                    <label>Key Gear / VSTs</label>
                                                    <textarea
                                                        style={{ height: "100px", width: "100%", padding: "8px", background: "var(--color-bg-3)", border: "1px solid var(--color-edge)", color: "white", borderRadius: "4px" }}
                                                        placeholder="Moog Sub37, Serum, UAD..."
                                                        onChange={(e: any) => userService.update({ techRider: { ...dna.techRider, integrations: e.target.value.split(",").map((s: string) => s.trim()) } })}
                                                    >{dna.techRider.integrations.join(", ")}</textarea>
                                                </div>
                                            </div>
                                        )
                                        if (tab === "goals") return (
                                            <div style={{ maxWidth: "600px" }}>
                                                <div className="form-group">
                                                    <label>Current Goals</label>
                                                    <textarea
                                                        style={{ height: "150px" }}
                                                        placeholder="What are you working towards? (e.g. 'Finish my first EP', 'Master compression')"
                                                        onChange={(e: any) => userService.update({ goals: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) })}
                                                    >{dna.goals.join(", ")}</textarea>
                                                </div>
                                            </div>
                                        )
                                        return <div></div>
                                    })
                                })()}
                            </div>

                            <div style={{ borderTop: "1px solid var(--color-edge)", paddingTop: "16px" }}>
                                <Button lifecycle={lifecycle} onClick={finishSetup} appearance={{ framed: true }} style={{ width: "100%", backgroundColor: "var(--color-blue-600)" }}>
                                    Save & Finish
                                </Button>
                            </div>
                        </div>
                    )
                }
            })}
        </div>
    )

    const content = ObserverView(lifecycle, currentStep, (step) => {
        console.log("OdieSetupView: Step Changed to", step, typeof step)
        if (step === 1) return renderStep1()
        if (step === 2) {
            console.log("OdieSetupView: Rendering Step 2")
            try {
                return renderStep2()
            } catch (e) {
                console.error("OdieSetupView: Step 2 Render Error", e)
                return <div>Error Rendering Step 2</div>
            }
        }
        if (step === 3) return renderStep3()
        console.error("OdieSetupView: Unknown Step", step)
        return <div>Error: Unknown Step {step}</div>
    })

    // Layout: Content Only (Sidebar handled by Router Page)
    return (
        <div className="content">
            {content}
        </div>
    )
}
