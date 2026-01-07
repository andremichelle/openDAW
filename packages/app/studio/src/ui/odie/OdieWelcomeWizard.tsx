import { createElement } from "@opendaw/lib-jsx"
import { OdieService } from "./OdieService"
import { checkModelTier } from "./services/llm/ModelPolicy"
import { userService } from "./services/UserService"
import { DefaultObservableValue, Terminator } from "@opendaw/lib-std"
import { Button } from "@/ui/components/Button"
import { TextInput } from "@/ui/components/TextInput"
import { Colors } from "@opendaw/studio-enums"
import { OdieModalFrame } from "./components/OdieModalFrame"

export const OdieWelcomeWizard = ({ service, onComplete, onClose }: { service: OdieService, onComplete: () => void, onClose?: () => void }) => {

    // -- Styling --
    const S = {
        // Full Screen Overlay
        overlay: {
            position: "fixed", top: "0", left: "0", width: "100vw", height: "100vh", zIndex: "99999",
            background: "rgba(0, 0, 0, 0.4)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "Inter, system-ui, sans-serif"
        },
        card: {
            width: "90%", maxWidth: "900px", maxHeight: "90vh",
            background: "#111111", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px",
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
            display: "flex", flexDirection: "column",
            overflowY: "auto", overflowX: "hidden",
            animation: "fadeInUp 0.3s ease-out"
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
            background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(255, 255, 255, 0.08)",
            borderRadius: "8px", padding: "24px", flex: "1",
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
            padding: "12px 24px", borderRadius: "4px", fontSize: "14px", fontWeight: "600",
            cursor: "pointer", width: "100%", transition: "all 0.2s",
            marginTop: "auto"
        },
        btnSecondary: {
            background: "rgba(255, 255, 255, 0.05)", border: "1px solid rgba(255, 255, 255, 0.1)", color: "#e2e8f0",
            padding: "10px 16px", borderRadius: "4px", fontSize: "13px", fontWeight: "500",
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
        },
        select: {
            background: "rgba(0,0,0,0.4)", border: "1px solid #334155", color: "white",
            padding: "10px", borderRadius: "8px", width: "100%", fontSize: "13px",
            outline: "none", cursor: "pointer", appearance: "none"
        },
        infoText: {
            fontSize: "12px", color: "#64748b", lineHeight: "1.5"
        },
        privacyNotice: {
            fontSize: "11px",
            color: "#94a3b8",
            lineHeight: "1.5",
            padding: "8px 12px",
            background: "rgba(0,0,0,0.2)",
            borderRadius: "8px",
            marginTop: "12px",
            border: "1px solid rgba(255,255,255,0.05)"
        },
        safetyNote: {
            background: "rgba(16, 185, 129, 0.05)", border: "1px solid rgba(16, 185, 129, 0.1)",
            padding: "12px", borderRadius: "8px", marginTop: "16px"
        },
        helpLink: {
            display: "inline-flex", alignItems: "center", gap: "6px",
            color: "#60a5fa", fontSize: "12px", fontWeight: "600",
            cursor: "pointer", textDecoration: "none", marginTop: "8px"
        },
        modalOverlay: {
            position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
            background: "rgba(0,0,0,0.85)", backdropFilter: "blur(10px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 1000, padding: "24px", animation: "fadeIn 0.2s ease-out"
        },
        modal: {
            background: "#1e293b", border: "1px solid #334155",
            borderRadius: "20px", width: "100%", maxWidth: "500px",
            maxHeight: "80vh", overflowY: "auto", position: "relative",
            boxShadow: "0 25px 50px -12px rgba(0,0,0,0.5)",
            display: "flex", flexDirection: "column"
        },
        guideHeader: {
            padding: "24px", borderBottom: "1px solid #334155",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            position: "sticky", top: 0, background: "#1e293b", zIndex: 10
        },
        guideBody: { padding: "24px", display: "flex", flexDirection: "column", gap: "20px" },
        guideSec: { display: "flex", flexDirection: "column", gap: "8px" },
        guideSecTitle: { fontSize: "11px", textTransform: "uppercase", letterSpacing: "1px", color: "#60a5fa", fontWeight: "800" },
        guideCard: {
            background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)",
            padding: "12px", borderRadius: "10px"
        },
        guideModelName: { fontSize: "13px", fontWeight: "700", color: "#f1f5f9", display: "flex", alignItems: "center", gap: "8px" },
        guideModelDesc: { fontSize: "12px", color: "#94a3b8", marginTop: "4px" },
        guideRAM: { fontSize: "10px", fontWeight: "700", padding: "2px 6px", borderRadius: "4px", background: "#334155", color: "#cbd5e1" }
    } as any

    const container = <div></div> as HTMLElement

    const lifecycle = new Terminator()
    const step = new DefaultObservableValue<number>(1)
    const nameModel = new DefaultObservableValue<string>(userService.dna.getValue().name || "")
    nameModel.catchupAndSubscribe(v => {
        const name = v.getValue()
        userService.update({ name })
        const isValid = name && name !== "Producer" && name.trim().length > 0
        const btn = document.getElementById("wizard-btn-start") as HTMLButtonElement
        const errorMsg = document.getElementById("wizard-error-name")
        if (btn) {
            btn.style.opacity = isValid ? "1" : "0.5"
            btn.style.cursor = isValid ? "pointer" : "not-allowed"
        }
        if (errorMsg) {
            errorMsg.style.display = isValid ? "none" : "block"
        }
    })
    let disposers: (() => void)[] = []

    // View State for Step 3
    let manualMode = false
    let activeProfileTab = "identity" // identity | sound | studio
    let showGuide = false

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


                // Strictly typed fetchModels check
                const models = (ollama.fetchModels) ? await ollama.fetchModels() : []
                if (models && models.length > 0) {
                    const bestModel = models[0]
                    statusText.innerHTML = `Online`
                    statusText.style.color = "#10b981"

                    // Populate Select
                    const select = uiScope.querySelector("#ollama-model-select") as HTMLSelectElement
                    const guidance = uiScope.querySelector("#ollama-hardware-guidance") as HTMLElement

                    const updateGuidance = (modelId: string) => {
                        if (!guidance) return
                        guidance.style.display = "block"
                        const isLarge = modelId.toLowerCase().includes("70b") || modelId.toLowerCase().includes("large")
                        const isMed = modelId.toLowerCase().includes("14b") || modelId.toLowerCase().includes("32b")
                        if (isLarge) guidance.innerHTML = "⚠️ <b>High RAM requirement.</b> 64GB+ recommended for smooth studio performance."
                        else if (isMed) guidance.innerHTML = "💡 <b>Medium RAM recommended.</b> 32GB recommended for complex projects."
                        else guidance.innerHTML = "✅ <b>Optimized for standard computers.</b> Runs well on most modern setups."

                        const tier = checkModelTier(modelId)
                        modelBadge.style.display = "block"
                        modelBadge.innerText = tier.label
                        modelBadge.style.background = tier.bg
                        modelBadge.style.color = tier.color
                    }

                    if (select) {
                        select.innerHTML = ""
                        models.forEach(m => {
                            const opt = document.createElement("option")
                            opt.value = m
                            opt.innerText = m
                            select.appendChild(opt)
                        })
                        select.style.display = "block"
                        select.onchange = () => updateGuidance(select.value)

                        // Initial update
                        updateGuidance(bestModel)
                    }

                    modelBadge.style.padding = "4px 8px"
                    modelBadge.style.borderRadius = "4px"
                    modelBadge.style.fontSize = "10px"
                    modelBadge.style.fontWeight = "bold"

                    btnUse.style.display = "block"
                } else {
                    statusText.innerText = "Connection Failed"
                    statusText.style.color = "#fbbf24"

                    // Specific Help for "No Models"
                    const badge = uiScope.querySelector("#ollama-model-badge") as HTMLElement

                    const debugLog = (ollama as any).debugLog || ""
                    const isCORS = debugLog.includes("Failed to fetch") || debugLog.includes("NetworkError")

                    if (badge) {
                        badge.style.display = "block"

                        if (isCORS) {
                            badge.style.background = "rgba(239, 68, 68, 0.1)"
                            badge.style.color = "#ef4444"
                            badge.style.border = "1px solid rgba(239, 68, 68, 0.2)"
                            badge.innerHTML = `
                                <div style="font-size:10px; margin-bottom:4px">🚫 CONNECTION BLOCKED</div>
                                <div style="font-size:10px; opacity:0.8; max-width:200px; line-height:1.4">
                                   Browser cannot reach Ollama.
                                   <br>Set env var: <code>OLLAMA_ORIGINS="*"</code>
                                </div>
                             `
                        } else {
                            // Genuine "No Models" case
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
                        }
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

        const ui = (
            <OdieModalFrame
                title={currentStep === 1 ? "Artist Identity" : (currentStep === 2 ? "System Config" : "Odie Arts Academy")}
                icon={currentStep === 3 ? "🎨" : (currentStep === 2 ? "⚙️" : "🆔")}
                onClose={() => { onClose && onClose() }}
                width="900px"
                height="85vh"
                headerContent={(
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
                        {[1, 2, 3].map(s => (
                            <div key={s} style={{
                                width: "10px", height: "10px", borderRadius: "50%",
                                backgroundColor: s === currentStep ? "#3b82f6" : "rgba(255,255,255,0.1)",
                                margin: "0 4px"
                            }} />
                        ))}
                    </div>
                )}
            >
                <div style={{ height: "100%", overflowY: "auto", display: "flex", flexDirection: "column" }}>

                    {/* --- STEP 1: INTELLIGENCE --- */}
                    {currentStep === 1 && (
                        <div id="step-1">
                            <div style={S.hero}>
                                <h1 style={S.h1}>Select Your AI Engine</h1>
                                <p style={S.intro}>
                                    Odie needs an AI "Brain" to help you create.
                                    Choose the option that best fits your setup.
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
                                        <div style={S.infoText}>
                                            Fast, smart, and effectively **Infinite**. Google Gemini offers a generous free tier.
                                        </div>
                                        <div style={S.privacyNotice}>
                                            <b>Privacy Note:</b> Free Tier data (outside EEA/UK) is anonymized and used to improve Google products. Use a <b>Paid Key</b> or <b>Local AI</b> for total privacy.
                                        </div>
                                        <div style={{ background: "rgba(59, 130, 246, 0.08)", padding: "16px", borderRadius: "12px", border: "1px solid rgba(59, 130, 246, 0.15)" }}>
                                            <div style={{ fontSize: "11px", textTransform: "uppercase", color: "#60a5fa", fontWeight: "bold", marginBottom: "8px" }}>Infinite API Setup</div>
                                            <div style={{ fontSize: "13px", marginBottom: "8px" }}>1. <a href="https://aistudio.google.com/app/apikey" target="_blank" style={{ color: "white", textDecoration: "underline" }}>Get Free Gemini API Key</a></div>
                                            <div style={{ fontSize: "12px", opacity: "0.8", marginBottom: "8px", lineHeight: "1.4" }}>
                                                Add multiple keys in <b>Settings</b> later to bypass rate limits and work uninterrupted.
                                            </div>
                                            <input id="gemini-key" type="password" placeholder="Paste API Key..." style={S.input} />
                                        </div>
                                        <Button
                                            lifecycle={lifecycle}
                                            appearance={{ framed: true, color: Colors.blue }}
                                            style={{ width: "100%", marginTop: "12px", height: "40px" }}
                                            onClick={async () => {
                                                const input = ui.querySelector("#gemini-key") as HTMLInputElement
                                                const key = input.value.trim()
                                                if (!key) return

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
                                                    }
                                                }
                                            }}>
                                            Connect Cloud
                                        </Button>
                                    </div>
                                </div>

                                {/* Local */}
                                <div style={S.col}>
                                    <div style={S.colHeader}>
                                        <span style={{ fontSize: "28px" }}>🏠</span>
                                        <div><div style={S.colTitle}>Local Brain</div><div style={S.colDesc}>Private. Free. Runs on your computer.</div></div>
                                    </div>
                                    <div style={S.box}>
                                        <div style={S.infoText}>
                                            Runs entirely on your own hardware. No subscription needed, internet not required, and **100% private**.
                                            <div style={{ marginTop: "12px", display: "flex", gap: "16px" }}>
                                                <a href="https://ollama.com/download" target="_blank" style={S.helpLink}>
                                                    📥 Download Ollama
                                                </a>
                                                <div style={S.helpLink} onclick={() => { showGuide = true; render(); }}>
                                                    💡 Help & Model Guide
                                                </div>
                                            </div>
                                        </div>
                                        <div style={{ background: "rgba(0,0,0,0.3)", padding: "16px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.05)" }}>
                                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
                                                <div>
                                                    <div style={{ fontSize: "11px", color: "#94a3b8", textTransform: "uppercase", fontWeight: "bold" }}>Local Engine Status</div>
                                                    <div id="ollama-status-text" style={{ color: "#f59e0b", fontSize: "13px", fontWeight: "700" }}>Checking...</div>
                                                </div>
                                                <button id="btn-scan-ollama" style={S.btnSecondary} onclick={() => checkOllama(ui)}>Scan</button>
                                            </div>

                                            <div id="ollama-model-badge" style={{ display: "none", marginBottom: "12px" }}></div>

                                            <div id="ollama-selector-area">
                                                <label style={{ ...S.label, fontSize: "10px" }}>Select Local Brain</label>
                                                <select id="ollama-model-select" style={{ ...S.select, display: "none", marginBottom: "12px" }}
                                                    onchange={(e: any) => {
                                                        const modelId = e.target.value
                                                        const badge = ui.querySelector("#ollama-model-badge") as HTMLElement
                                                        const validation = checkModelTier(modelId)
                                                        if (badge) {
                                                            badge.innerText = validation.label
                                                            badge.style.background = validation.bg
                                                            badge.style.color = validation.color
                                                        }
                                                    }}
                                                ></select>
                                            </div>

                                            <div id="ollama-hardware-guidance" style={{ ...S.infoText, fontSize: "11px", display: "none" }}></div>
                                        </div>

                                        <div style={S.safetyNote}>
                                            <div style={{ fontSize: "11px", fontWeight: "800", color: "#10b981", marginBottom: "4px" }}>🛡️ DAW SAFETY VERIFIED</div>
                                            <div style={{ fontSize: "11px", color: "#64748b", lineHeight: "1.4" }}>
                                                Odie runs on a separate process. Even if the AI works hard, your <b>Audio Engine</b> remains high-priority and won't skip a beat.
                                            </div>
                                        </div>

                                        <button id="btn-use-ollama" style={{ ...S.btnPrimary, background: "#10b981", color: "#064e3b", display: "none" }} onclick={() => {
                                            const select = ui.querySelector("#ollama-model-select") as HTMLSelectElement
                                            const modelId = select?.value || "ollama"
                                            service.ai.setConfig("ollama", { modelId })
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
                                    <div style={{
                                        width: "100%", maxWidth: "400px", margin: "0 auto",
                                        fontSize: "28px", textAlign: "center",
                                        background: "rgba(255,255,255,0.05)",
                                        borderRadius: "12px",
                                        border: dna.name === "Producer" || !dna.name ? "1px solid rgba(248, 113, 113, 0.4)" : "1px solid #10b981",
                                        overflow: "hidden"
                                    }}>
                                        <TextInput lifecycle={lifecycle} model={nameModel} />
                                    </div>
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
            </OdieModalFrame>
        )

        container.appendChild(ui)

        if (showGuide) {
            const guide = (
                <div style={S.modalOverlay} onclick={() => { showGuide = false; render(); }}>
                    <div style={S.modal} onclick={(e: any) => e.stopPropagation()}>
                        <div style={S.guideHeader}>
                            <div style={{ fontSize: "16px", fontWeight: "800", color: "white" }}>Local Model Guide (Jan 2026)</div>
                            <div style={{ cursor: "pointer", fontSize: "20px", color: "#94a3b8" }} onclick={() => { showGuide = false; render(); }}>✕</div>
                        </div>
                        <div style={S.guideBody}>
                            <div style={S.guideSec}>
                                <div style={S.guideSecTitle}>Elite Recommendations</div>
                                <div style={S.guideCard}>
                                    <div style={S.guideModelName}>⚡ Speed: Qwen3-Coder 1.7B/7B <span style={S.guideRAM}>8GB-16GB RAM</span></div>
                                    <div style={S.guideModelDesc}>Instant responses. Perfect for quick creative ideas and background tasks.</div>
                                </div>
                                <div style={S.guideCard}>
                                    <div style={S.guideModelName}>⚖️ Balance: Qwen3-Coder 14B / DeepSeek V3.2 Lite <span style={S.guideRAM}>32GB RAM</span></div>
                                    <div style={S.guideModelDesc}>The Sweet Spot. Deep musical logic with professional reasoning speed.</div>
                                </div>
                                <div style={S.guideCard}>
                                    <div style={S.guideModelName}>🧠 Advanced: Qwen3-Coder 32B / DeepSeek V3.2 <span style={S.guideRAM}>64GB+ RAM</span></div>
                                    <div style={S.guideModelDesc}>State-of-the-art power. Best for complex session management and deep research.</div>
                                </div>
                            </div>

                            <div style={S.guideSec}>
                                <div style={S.guideSecTitle}>How to Install</div>
                                <div style={S.infoText}>
                                    Run this command in your terminal:<br />
                                    <code style={{ background: "black", padding: "4px 8px", borderRadius: "4px", display: "inline-block", marginTop: "4px", color: "#10b981", fontSize: "11px", fontFamily: "monospace" }}>
                                        ollama run qwen3-coder:7b
                                    </code>
                                </div>
                            </div>

                            <div style={S.guideSec}>
                                <div style={S.guideSecTitle}>Check Your Specs</div>
                                <div style={S.guideCard}>
                                    <div style={{ ...S.infoText, color: "#f1f5f9" }}><b>Mac:</b>  Menu → About This Mac → Memory</div>
                                    <div style={{ ...S.infoText, color: "#f1f5f9", marginTop: "4px" }}><b>Windows:</b> Settings → System → About → RAM</div>
                                    <div style={{ ...S.infoText, color: "#f1f5f9", marginTop: "4px" }}><b>Linux:</b> Terminal → <code>free -h</code></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )
            container.appendChild(guide)
        }

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
        s.textContent = `@keyframes fadeInUp {from {opacity: 0; transform: translateY(20px); scale: 0.95; } to {opacity: 1; transform: translateY(0); scale: 1; } }`
        document.head.appendChild(s)
    }

    return container
}
