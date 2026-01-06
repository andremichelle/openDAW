
import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { checkModelTier } from "./services/llm/ModelPolicy"
import { userService } from "./services/UserService"
import { DefaultObservableValue } from "@opendaw/lib-std"

export const OdieWelcomeWizard = ({ service, onComplete, onClose }: { service: OdieService, onComplete: () => void, onClose?: () => void }) => {

    // -- Styling --
    const S = {
        // Full Screen Overlay
        overlay: {
            position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh", zIndex: "99999",
            background: "rgba(0, 0, 0, 0.85)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "Inter, system-ui, sans-serif"
        },
        card: {
            width: "90%", maxWidth: "900px", maxHeight: "90vh",
            background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "24px",
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
            display: "flex", flexDirection: "column",
            overflowY: "auto", overflowX: "hidden",
            animation: "fadeInUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)"
        },

        // Header Section
        header: {
            padding: "20px", display: "flex", justifyContent: "center", borderBottom: "1px solid rgba(255,255,255,0.05)",
            position: "relative" as "relative"
        },
        stepDots: {
            display: "flex", gap: "10px"
        },
        hero: {
            padding: "40px", textAlign: "center", borderBottom: "1px solid rgba(255,255,255,0.05)",
            background: "linear-gradient(180deg, rgba(30, 41, 59, 0.5) 0%, rgba(15, 23, 42, 0) 100%)"
        },
        h1: {
            fontSize: "32px", fontWeight: "800", margin: "0 0 16px 0", letterSpacing: "-1px",
            background: "linear-gradient(135deg, #fff 0%, #94a3b8 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent"
        },
        intro: { fontSize: "15px", color: "#94a3b8", lineHeight: "1.6", maxWidth: "600px", margin: "0 auto" },

        // 2-Column Grid
        grid: {
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: "32px", padding: "40px",
            alignItems: "stretch"
        },

        // Column Styling
        col: { display: "flex", flexDirection: "column", gap: "24px" },
        colHeader: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" },
        colTitle: { fontSize: "18px", fontWeight: "700", color: "#f1f5f9" },
        colDesc: { fontSize: "13px", color: "#64748b" },

        // Option Box
        box: {
            background: "rgba(255, 255, 255, 0.03)", border: "1px solid rgba(255, 255, 255, 0.06)",
            borderRadius: "16px", padding: "24px", flex: "1",
            display: "flex", flexDirection: "column", gap: "16px",
            cursor: "pointer", transition: "all 0.2s"
        },

        // Inputs & Buttons
        input: {
            background: "rgba(0,0,0,0.3)", border: "1px solid #334155", color: "white",
            padding: "12px", borderRadius: "8px", width: "100%", fontSize: "13px", fontFamily: "monospace"
        },
        btnPrimary: {
            background: "#3b82f6", color: "white", border: "none",
            padding: "14px", borderRadius: "8px", fontSize: "14px", fontWeight: "600",
            cursor: "pointer", width: "100%", transition: "all 0.2s",
            boxShadow: "0 4px 6px -1px rgba(59, 130, 246, 0.3)",
            marginTop: "auto"
        },
        btnSecondary: {
            background: "transparent", border: "1px solid #475569", color: "#e2e8f0",
            padding: "10px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: "500",
            cursor: "pointer", transition: "all 0.2s"
        },

        // Badges
        badge: {
            fontSize: "11px", fontWeight: "700", padding: "4px 8px", borderRadius: "100px",
            textTransform: "uppercase", letterSpacing: "0.5px"
        },
        label: {
            fontSize: "11px", textTransform: "uppercase", letterSpacing: "1px", fontWeight: "700",
            color: "#94a3b8", marginBottom: "8px", display: "block"
        }
    }

    const container = <div style={S.overlay}></div> as HTMLElement

    // Wizard State
    const step = new DefaultObservableValue<number>(1)
    let disposers: (() => void)[] = []

    // View State for Step 3
    let manualMode = false
    let activeProfileTab = "identity" // identity | sound | studio

    const render = () => {
        // Cleanup previous subscriptions
        disposers.forEach(d => d())
        disposers = []

        // Clear previous UI
        container.innerHTML = ""

        const currentStep = step.getValue()
        const hasWide = window.innerWidth > 800
        const gridStyle = hasWide ? S.grid : { ...S.grid, gridTemplateColumns: "1fr" }

        // --- Helper: Ollama Check ---
        const checkOllama = async (uiScope: HTMLElement) => {
            const statusText = uiScope.querySelector("#ollama-status-text") as HTMLElement
            const btnUse = uiScope.querySelector("#btn-use-ollama") as HTMLElement
            const modelBadge = uiScope.querySelector("#ollama-model-badge") as HTMLElement

            if (!statusText) return

            statusText.innerText = "Pinging..."
            statusText.style.color = "#94a3b8"

            const ollama = service.ai.getProvider("ollama")
            if (!ollama) return

            try {
                const cfg = service.ai.getConfig("ollama")
                if (!cfg.baseUrl || cfg.baseUrl.includes("/v1")) {
                    ollama.configure({ ...cfg, baseUrl: "/api/ollama/api/chat" })
                }

                // Strictly typed fetchModels check
                const models = (ollama.fetchModels) ? await ollama.fetchModels() : []
                if (models && models.length > 0) {
                    const bestModel = models[0]
                    const validation = checkModelTier(bestModel)

                    statusText.innerHTML = `Online <span style="font-weight:400; color:#94a3b8; font-size:11px">(${bestModel})</span>`
                    statusText.style.color = "#10b981"

                    // Badge
                    modelBadge.style.display = "block"
                    modelBadge.innerText = validation.label
                    modelBadge.style.padding = "4px 8px"
                    modelBadge.style.borderRadius = "4px"
                    modelBadge.style.fontSize = "10px"
                    modelBadge.style.fontWeight = "bold"
                    modelBadge.style.background = validation.bg
                    modelBadge.style.color = validation.color

                    btnUse.style.display = "block"
                } else {
                    statusText.innerText = "No Models Found"
                    statusText.style.color = "#fbbf24"

                    // Specific Help for "No Models"
                    const badge = uiScope.querySelector("#ollama-model-badge") as HTMLElement
                    if (badge) {
                        badge.style.display = "block"
                        badge.style.background = "rgba(251, 191, 36, 0.1)"
                        badge.style.color = "#fbbf24"
                        badge.style.border = "1px solid rgba(251, 191, 36, 0.2)"
                        badge.innerHTML = `
                            <div style="font-size:10px; margin-bottom:4px">MISSING BRAIN</div>
                            <div style="font-size:11px; font-family:monospace; background:rgba(0,0,0,0.3); padding:4px; border-radius:4px; display:flex; gap:8px; align-items:center">
                                ollama pull qwen2.5-coder
                                <button style="background:#fbbf24; color:black; border:none; border-radius:3px; font-size:9px; padding:2px 6px; cursor:pointer" onclick="navigator.clipboard.writeText('ollama pull qwen2.5-coder')">COPY</button>
                            </div>
                         `
                        badge.style.padding = "8px"
                    }

                    btnUse.style.display = "none"
                }
            } catch (e) {
                statusText.innerText = "Not Found"
                statusText.style.color = "#ef4444"
                btnUse.style.display = "none"
            }
        }

        // --- Helper: Factory Reset ---
        const factoryReset = () => {
            if (confirm("⚠️ RESET ODIE?\n\nThis will wipe your chat history, settings, and profile to simulate a fresh install.\n\nAre you sure?")) {
                localStorage.clear()
                location.reload()
            }
        }

        const ui = <div style={S.card}>

            {/* --- HEADER --- */}
            <div style={S.header}>
                {onClose && (
                    <button
                        style={{
                            position: "absolute", right: "20px", top: "50%", transform: "translateY(-50%)",
                            background: "transparent", border: "none", color: "rgba(255,255,255,0.3)",
                            fontSize: "24px", cursor: "pointer", transition: "color 0.2s"
                        }}
                        onmouseenter={(e: any) => e.target.style.color = "white"}
                        onmouseleave={(e: any) => e.target.style.color = "rgba(255,255,255,0.3)"}
                        onclick={onClose}
                        title="Exit Setup"
                    >✕</button>
                )}
                <div style={S.stepDots}>
                    {/* Ghost Button for Factory Reset (Debug) */}
                    <div
                        onclick={factoryReset}
                        title="Debug: Factory Reset"
                        style={{
                            width: "10px", height: "10px", borderRadius: "50%", background: "transparent",
                            cursor: "pointer", marginRight: "20px"
                        }}
                    />
                    {[1, 2, 3].map(s => { // 3 Steps now
                        const active = s === currentStep
                        // Visuals...
                        return <div key={s} style={{
                            width: "10px", height: "10px",
                            borderRadius: "50%",
                            backgroundColor: active ? "#00E0FF" : "rgba(255,255,255,0.1)",
                            boxShadow: active ? "0px 0px 10px #00E0FF" : "none"
                        }} />
                    })}
                </div>
            </div>

            {/* --- STEP 1: INTELLIGENCE --- */}
            {currentStep === 1 && (
                <div id="step-1">
                    <div style={S.hero}>
                        <h1 style={S.h1}>Wake Up Your Studio Assistant</h1>
                        <p style={S.intro}>
                            Hi, I'm Odie. I need a "Brain" (LLM) to function.
                            Choose your intelligence engine.
                        </p>
                    </div>

                    <div style={gridStyle}>
                        {/* Cloud */}
                        <div style={S.col}>
                            <div style={S.colHeader}>
                                <span style={{ fontSize: "28px" }}>☁️</span>
                                <div><div style={S.colTitle}>Cloud Power</div><div style={S.colDesc}>Easiest setup. Best reasoning.</div></div>
                                <div style={{ ...S.badge, background: "rgba(59, 130, 246, 0.2)", color: "#93c5fd", marginLeft: "auto" }}>Recommended</div>
                            </div>
                            <div style={S.box}>
                                <div style={{ fontSize: "14px", lineHeight: "1.5", color: "#cbd5e1" }}>
                                    <strong>Google Gemini</strong> is our preferred cloud brain.
                                </div>
                                <div style={{ background: "rgba(59, 130, 246, 0.08)", padding: "16px", borderRadius: "12px", border: "1px solid rgba(59, 130, 246, 0.15)" }}>
                                    <div style={{ fontSize: "11px", textTransform: "uppercase", color: "#60a5fa", fontWeight: "bold", marginBottom: "8px" }}>Quick Setup</div>
                                    <div style={{ fontSize: "13px", marginBottom: "8px" }}>1. <a href="https://aistudio.google.com/app/apikey" target="_blank" style={{ color: "white", textDecoration: "underline" }}>Get Free Gemini API Key</a></div>
                                    <input id="gemini-key" type="password" placeholder="Paste API Key..." style={S.input} />
                                </div>
                                <button id="btn-connect-gemini" style={S.btnPrimary} onclick={async () => {
                                    const btn = ui.querySelector("#btn-connect-gemini") as HTMLElement
                                    const input = ui.querySelector("#gemini-key") as HTMLInputElement
                                    const key = input.value.trim()
                                    if (!key) return
                                    btn.innerText = "Verifying..."
                                    const gemini = service.ai.getProvider("gemini")
                                    if (gemini) {
                                        gemini.configure({ apiKey: key })
                                        const res = await gemini.validate!()
                                        if (res.ok) {
                                            service.ai.setConfig("gemini", { apiKey: key })
                                            service.ai.setActiveProvider("gemini")
                                            step.setValue(2) // NEXT STEP
                                        } else {
                                            alert("Connection Failed: " + res.message)
                                            btn.innerText = "Connect Cloud"
                                        }
                                    }
                                }}>Connect Cloud</button>
                            </div>
                        </div>

                        {/* Local */}
                        <div style={S.col}>
                            <div style={S.colHeader}>
                                <span style={{ fontSize: "28px" }}>🏠</span>
                                <div><div style={S.colTitle}>Local Privacy</div><div style={S.colDesc}>Offline. Private. Yours.</div></div>
                            </div>
                            <div style={S.box}>
                                <div style={{ fontSize: "13px", lineHeight: "1.5", color: "#cbd5e1" }}>
                                    Run the brain on your own hardware via <strong>Ollama</strong>.
                                </div>
                                <div style={{ background: "rgba(0,0,0,0.3)", padding: "16px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                                    <div>
                                        <div style={{ fontSize: "11px", color: "#94a3b8", textTransform: "uppercase", fontWeight: "bold" }}>Ollama Status</div>
                                        <div id="ollama-status-text" style={{ color: "#f59e0b", fontSize: "13px", fontWeight: "700" }}>Scanning...</div>
                                    </div>
                                    <div id="ollama-model-badge" style={{ display: "none" }}></div>
                                    <button id="btn-scan-ollama" style={S.btnSecondary} onclick={() => checkOllama(ui)}>Check</button>
                                </div>
                                <button id="btn-use-ollama" style={{ ...S.btnPrimary, background: "#10b981", color: "#064e3b", display: "none" }} onclick={() => {
                                    service.ai.setActiveProvider("ollama")
                                    step.setValue(2) // NEXT STEP
                                }}>Use Local AI</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* --- STEP 2: WELCOME / EDUCATION --- */}
            {currentStep === 2 && (
                <div id="step-2" style={{ animation: "fadeInUp 0.4s ease-out" }}>
                    <div style={S.hero}>
                        <h1 style={S.h1}>System Online. Hello, Creator.</h1>
                        <p style={S.intro}>
                            I am <strong>Odie</strong>, your AI co-producer. <br />
                            I am deeply integrated into this DAW to help you create faster.
                        </p>
                    </div>

                    <div style={{ padding: "40px", display: "grid", gridTemplateColumns: hasWide ? "1fr 1fr 1fr" : "1fr", gap: "24px" }}>
                        <div style={S.box}>
                            <div style={{ fontSize: "32px", marginBottom: "12px" }}>🎛️</div>
                            <div style={S.colTitle}>The Operator</div>
                            <div style={{ fontSize: "14px", color: "#cbd5e1", lineHeight: "1.6" }}>
                                I control the studio directly. Ask me to:
                            </div>
                            <ul style={{ fontSize: "13px", color: "#94a3b8", paddingLeft: "16px", margin: "0", lineHeight: "1.8" }}>
                                <li>"Add a drum track"</li>
                                <li>"Set BPM to 128"</li>
                                <li>"Export mixdown"</li>
                            </ul>
                        </div>
                        <div style={S.box}>
                            <div style={{ fontSize: "32px", marginBottom: "12px" }}>🧠</div>
                            <div style={S.colTitle}>The Mentor</div>
                            <div style={{ fontSize: "14px", color: "#cbd5e1", lineHeight: "1.6" }}>
                                I know audio engineering. Ask me about:
                            </div>
                            <ul style={{ fontSize: "13px", color: "#94a3b8", paddingLeft: "16px", margin: "0", lineHeight: "1.8" }}>
                                <li>"How do I compress vocals?"</li>
                                <li>"Explain this EQ setting"</li>
                                <li>"What is parallel compression?"</li>
                            </ul>
                        </div>
                        <div style={S.box}>
                            <div style={{ fontSize: "32px", marginBottom: "12px" }}>✨</div>
                            <div style={S.colTitle}>The Collaborator</div>
                            <div style={{ fontSize: "14px", color: "#cbd5e1", lineHeight: "1.6" }}>
                                I am creative. Ask me for:
                            </div>
                            <ul style={{ fontSize: "13px", color: "#94a3b8", paddingLeft: "16px", margin: "0", lineHeight: "1.8" }}>
                                <li>"Give me ideas for this track"</li>
                                <li>"Write lyrics about space"</li>
                                <li>"Suggest a chord progression"</li>
                            </ul>
                        </div>
                    </div>

                    <div style={{ padding: "0 40px 40px 40px", display: "flex", justifyContent: "center", gap: "16px", alignItems: "center" }}>
                        <button style={S.btnSecondary} onclick={() => step.setValue(1)}>
                            ← Back
                        </button>
                        <button style={{ ...S.btnPrimary, maxWidth: "300px", fontSize: "16px", padding: "16px", marginTop: "0" }} onclick={() => step.setValue(3)}>
                            Next: Tell Me About You ➡️
                        </button>
                    </div>
                </div>
            )}

            {/* --- STEP 3: USER PROFILE --- */}
            {currentStep === 3 && (() => {
                const dna = userService.dna.getValue()

                // --- MANUAL MODE (Full Profile Editor) ---
                if (manualMode) {
                    const renderTabBtn = (id: string, label: string, icon: string) => {
                        const isActive = activeProfileTab === id
                        return <div
                            onclick={() => { activeProfileTab = id; render() }}
                            style={{
                                padding: "12px 16px", borderRadius: "8px",
                                background: isActive ? "rgba(255,255,255,0.1)" : "transparent",
                                color: isActive ? "white" : "#94a3b8",
                                cursor: "pointer", display: "flex", alignItems: "center", gap: "12px",
                                fontWeight: isActive ? "600" : "400", transition: "all 0.2s",
                                marginBottom: "4px"
                            }}
                        >
                            <span style={{ fontSize: "18px" }}>{icon}</span>
                            <span>{label}</span>
                        </div>
                    }

                    let tabContent
                    if (activeProfileTab === "identity") {
                        tabContent = <div>
                            <div style={S.colHeader}><div style={S.colTitle}>Name / Alias</div></div>
                            <input type="text" value={dna.name === "Producer" ? "" : dna.name} style={{ ...S.input, marginBottom: "24px" }} placeholder="Producer"
                                onchange={(e: any) => { userService.update({ name: e.target.value }); render() }} />

                            <div style={S.box}><div style={S.colTitle}>Experience Level</div>
                                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px", marginTop: "12px" }}>
                                    {["beginner", "intermediate", "advanced", "pro"].map(l => (
                                        <div style={{
                                            ...S.btnSecondary, background: dna.level === l ? "#3b82f6" : "rgba(255,255,255,0.05)",
                                            color: dna.level === l ? "white" : "#94a3b8", textAlign: "center", cursor: "pointer"
                                        }} onclick={() => { userService.update({ level: l as any }); render() }}>
                                            {l.charAt(0).toUpperCase() + l.slice(1)}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div style={{ marginTop: "24px" }}>
                                <label style={S.label}>Location</label>
                                <input type="text" value={dna.identity.location} style={S.input} placeholder="e.g. Los Angeles"
                                    onchange={(e: any) => { userService.update({ identity: { ...dna.identity, location: e.target.value } }); render() }} />
                            </div>
                            <div style={{ marginTop: "24px" }}>
                                <label style={S.label}>Role</label>
                                <select style={S.input} onchange={(e: any) => { userService.update({ identity: { ...dna.identity, role: e.target.value } }); render() }}>
                                    {["producer", "songwriter", "mixer", "sound_designer", "artist"].map(r =>
                                        <option value={r} selected={dna.identity.role === r}>{r.toUpperCase().replace("_", " ")}</option>
                                    )}
                                </select>
                            </div>
                        </div>
                    } else if (activeProfileTab === "sound") {
                        tabContent = <div>
                            <div>
                                <label style={S.label}>Primary Genre</label>
                                <input type="text" value={dna.sonicFingerprint.primaryGenre} style={S.input} placeholder="e.g. Melodic Techno"
                                    onchange={(e: any) => { userService.update({ sonicFingerprint: { ...dna.sonicFingerprint, primaryGenre: e.target.value } }); render() }} />
                            </div>
                            <div style={{ marginTop: "24px" }}>
                                <label style={S.label}>Vibe Keywords</label>
                                <input type="text" value={dna.sonicFingerprint.vibeKeywords.join(", ")} style={S.input} placeholder="e.g. Dark, Ethereal"
                                    onchange={(e: any) => { userService.update({ sonicFingerprint: { ...dna.sonicFingerprint, vibeKeywords: e.target.value.split(",").map((s: string) => s.trim()) } }); render() }} />
                            </div>
                            <div style={{ marginTop: "24px" }}>
                                <label style={S.label}>Influences</label>
                                <textarea style={{ ...S.input, height: "80px" }} placeholder="e.g. Hans Zimmer, Skrillex..."
                                    onchange={(e: any) => { userService.update({ influences: e.target.value.split(",").map((s: string) => s.trim()).filter((Boolean)) }); render() }}
                                >{dna.influences.join(", ")}</textarea>
                            </div>
                        </div>
                    } else if (activeProfileTab === "studio") {
                        tabContent = <div>
                            <div>
                                <label style={S.label}>Workflow</label>
                                <select style={S.input} onchange={(e: any) => { userService.update({ techRider: { ...dna.techRider, workflow: e.target.value } }); render() }}>
                                    <option value="in-the-box" selected={dna.techRider.workflow === "in-the-box"}>Software Only</option>
                                    <option value="hybrid" selected={dna.techRider.workflow === "hybrid"}>Hybrid</option>
                                    <option value="outboard-heavy" selected={dna.techRider.workflow === "outboard-heavy"}>Analog Heavy</option>
                                </select>
                            </div>
                            <div style={{ marginTop: "24px" }}>
                                <label style={S.label}>Key Gear / VSTs</label>
                                <textarea style={{ ...S.input, height: "100px" }} placeholder="List your key gear..."
                                    onchange={(e: any) => { userService.update({ techRider: { ...dna.techRider, integrations: e.target.value.split(",").map((s: string) => s.trim()) } }); render() }}
                                >{dna.techRider.integrations.join(", ")}</textarea>
                            </div>
                        </div>
                    } else if (activeProfileTab === "goals") {
                        tabContent = <div>
                            <label style={S.label}>Current Goals</label>
                            <textarea style={{ ...S.input, height: "120px" }} placeholder="What are you working towards?"
                                onchange={(e: any) => { userService.update({ goals: e.target.value.split(",").map((s: string) => s.trim()) }); render() }}
                            >{dna.goals.join(", ")}</textarea>
                        </div>
                    }

                    return <div id="step-3-manual" style={{ display: "grid", gridTemplateColumns: "250px 1fr", height: "500px", animation: "fadeInUp 0.3s ease-out" }}>
                        {/* Sidebar */}
                        <div style={{ background: "rgba(0,0,0,0.2)", padding: "24px", borderRight: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column" }}>
                            <div style={{ display: "flex", alignItems: "center", marginBottom: "16px" }}>
                                <button style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}
                                    onclick={() => { manualMode = false; render() }}>
                                    ← BACK
                                </button>
                            </div>

                            <div style={{ width: "80px", height: "80px", borderRadius: "50%", background: "linear-gradient(135deg, #6366f1 0%, #a855f7 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "32px", margin: "0 auto 16px auto", boxShadow: "0 0 20px rgba(168, 85, 247, 0.4)" }}>
                                {dna.name.charAt(0).toUpperCase()}
                            </div>
                            <div style={{ textAlign: "center", fontWeight: "700", marginBottom: "4px" }}>{dna.name}</div>
                            <div style={{ textAlign: "center", fontSize: "11px", color: "#64748b", marginBottom: "24px" }}>{dna.level.toUpperCase()}</div>

                            {renderTabBtn("identity", "Identity", "🆔")}
                            {renderTabBtn("sound", "Sound", "🌊")}
                            {renderTabBtn("studio", "Studio", "🎛️")}
                            {renderTabBtn("goals", "Goals", "🚀")}

                            <button
                                style={{
                                    ...S.btnPrimary, marginTop: "auto",
                                    opacity: (dna.name === "Producer" || !dna.name) ? "0.5" : "1",
                                    cursor: (dna.name === "Producer" || !dna.name) ? "not-allowed" : "pointer"
                                }}
                                onclick={() => {
                                    if (dna.name === "Producer" || !dna.name) {
                                        alert("Please enter a valid name in the Identity tab.")
                                        return
                                    }
                                    onComplete()
                                }}>
                                Save & Finish ✅
                            </button>
                        </div>
                        {/* Main */}
                        <div style={{ padding: "32px", overflowY: "auto" }}>
                            <h2 style={{ fontSize: "24px", fontWeight: "700", marginBottom: "24px", color: "white", paddingBottom: "16px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                                {activeProfileTab.charAt(0).toUpperCase() + activeProfileTab.slice(1)}
                            </h2>
                            {tabContent}
                        </div>
                    </div>
                }

                // --- CHOICE MODE (Default View) ---
                return <div id="step-3" style={{ animation: "fadeInUp 0.4s ease-out" }}>
                    <div style={S.hero}>
                        <h1 style={S.h1}>Let's Get Started</h1>
                        <p style={S.intro}>
                            Speed or Depth? It's your call.
                        </p>
                    </div>

                    <div style={{ padding: "40px", maxWidth: "600px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "32px" }}>

                        {/* 1. Essential: Name */}
                        <div style={{ textAlign: "center" }}>
                            <div style={{ display: "flex", justifyContent: "center", marginBottom: "32px" }}>
                                <button style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: "14px", fontWeight: "600", display: "flex", alignItems: "center", gap: "8px" }}
                                    onclick={() => step.setValue(2)}>
                                    ← Back
                                </button>
                            </div>
                            <label style={{ ...S.label, textAlign: "center", fontSize: "12px", marginBottom: "16px" }}>Minimum Requirement: Artist Name</label>
                            <input
                                id="wizard-input-name"
                                type="text"
                                value={dna.name === "Producer" ? "" : dna.name}
                                placeholder="Enter your name..."
                                style={{
                                    ...S.input, fontSize: "28px", textAlign: "center", padding: "16px",
                                    background: "rgba(255,255,255,0.05)",
                                    border: dna.name === "Producer" || !dna.name ? "1px solid rgba(248, 113, 113, 0.4)" : "1px solid #10b981",
                                    boxShadow: "0 4px 20px rgba(0,0,0,0.2)"
                                }}
                                oninput={(e: any) => {
                                    const val = e.target.value
                                    userService.update({ name: val })

                                    // Granular Update (Prevents Focus Loss)
                                    const btn = document.getElementById("wizard-btn-start") as HTMLButtonElement
                                    const border = e.target
                                    const errorMsg = document.getElementById("wizard-error-name")

                                    const isValid = val && val !== "Producer" && val.trim().length > 0

                                    if (border) {
                                        border.style.borderColor = isValid ? "#10b981" : "rgba(248, 113, 113, 0.4)"
                                    }

                                    if (btn) {
                                        btn.style.opacity = isValid ? "1" : "0.5"
                                        btn.style.cursor = isValid ? "pointer" : "not-allowed"
                                    }

                                    if (errorMsg) {
                                        errorMsg.style.display = isValid ? "none" : "block"
                                    }
                                }}
                            />
                            <div id="wizard-error-name" style={{
                                color: "#f87171", fontSize: "12px", marginTop: "8px", fontWeight: "600",
                                display: (dna.name === "Producer" || !dna.name) ? "block" : "none"
                            }}>
                                Please enter a name to continue.
                            </div>
                        </div>

                        {/* 2. Main Action: Start */}
                        <button
                            id="wizard-btn-start"
                            style={{
                                ...S.btnPrimary,
                                fontSize: "18px", padding: "20px",
                                opacity: (dna.name === "Producer" || !dna.name) ? "0.5" : "1",
                                cursor: (dna.name === "Producer" || !dna.name) ? "not-allowed" : "pointer",
                                transform: "scale(1)",
                            }}
                            onclick={() => {
                                const currentName = userService.dna.getValue().name
                                if (currentName === "Producer" || !currentName) return
                                onComplete()
                                console.log("Profile setup basic. Click passport later.")
                            }}
                        >
                            I Just Want to Make Music (Skip Profile) ⚡
                        </button>

                        {/* 3. Optional: Profile Setup */}
                        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "32px", marginTop: "8px" }}>
                            <div style={{ textAlign: "center", marginBottom: "24px" }}>
                                <div style={{ fontSize: "13px", color: "#94a3b8", textTransform: "uppercase", fontWeight: "700", letterSpacing: "1px", marginBottom: "8px" }}>
                                    🚀 Or... Do It The Right Way
                                </div>
                                <div style={{ fontSize: "14px", color: "#94a3b8", maxWidth: "480px", margin: "0 auto", lineHeight: "1.5" }}>
                                    Help me understand your sound, gear, and goals. I can't be a good partner if I don't know who you are.
                                    Take 2 minutes to calibrate me.
                                </div>
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
                                {/* Manual Entry */}
                                <div
                                    style={{
                                        background: "rgba(255,255,255,0.03)", borderRadius: "12px", padding: "20px", cursor: "pointer",
                                        border: "1px solid rgba(255,255,255,0.05)", transition: "all 0.2s", display: "flex", alignItems: "center", gap: "16px"
                                    }}
                                    onmouseenter={(e: any) => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
                                    onmouseleave={(e: any) => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                                    onclick={() => { manualMode = true; render() }}
                                >
                                    <div style={{ fontSize: "24px" }}>📝</div>
                                    <div>
                                        <div style={{ ...S.colTitle, fontSize: "15px" }}>Complete Profile</div>
                                        <div style={{ fontSize: "12px", color: "#64748b" }}>The comprehensive setup</div>
                                    </div>
                                </div>

                                {/* Interview */}
                                <div
                                    style={{
                                        background: "rgba(255,255,255,0.03)", borderRadius: "12px", padding: "20px", cursor: "pointer",
                                        border: "1px solid rgba(255,255,255,0.05)", transition: "all 0.2s", display: "flex", alignItems: "center", gap: "16px"
                                    }}
                                    onmouseenter={(e: any) => e.currentTarget.style.background = "rgba(255,255,255,0.06)"}
                                    onmouseleave={(e: any) => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                                    onclick={() => {
                                        if (dna.name === "Producer" || !dna.name) {
                                            alert("Please enter your name first.")
                                            return
                                        }
                                        onComplete()
                                        setTimeout(() => {
                                            service.sendMessage("Hi Odie. I'm ready to set up my profile. Please interview me to build my artist passport.")
                                        }, 500)
                                    }}
                                >
                                    <div style={{ fontSize: "24px" }}>🎤</div>
                                    <div>
                                        <div style={{ ...S.colTitle, fontSize: "15px" }}>Interview Me</div>
                                        <div style={{ fontSize: "12px", color: "#64748b" }}>Chat with Odie</div>
                                    </div>
                                </div>
                            </div>
                        </div>

                    </div>
                </div>
            })()}

        </div>

        container.appendChild(ui)

        // Post-Render Effects
        if (currentStep === 1) {
            setTimeout(() => checkOllama(ui), 500)
        }
    }

    // Main State Subscriptions
    step.subscribe(() => render())

    render()

    if (!document.getElementById("odie-wiz-style")) {
        const s = document.createElement("style")
        s.id = "odie-wiz-style"
        s.textContent = `@keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); scale: 0.95; } to { opacity: 1; transform: translateY(0); scale: 1; } }`
        document.head.appendChild(s)
    }

    return container
}
