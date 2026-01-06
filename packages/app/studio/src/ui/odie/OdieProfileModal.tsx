import { createElement } from "@opendaw/lib-jsx"
import { OdieModalFrame } from "./components/OdieModalFrame"
import { userService } from "./services/UserService"

const S = {
    layout: {
        display: "grid", gridTemplateColumns: "300px 1fr", height: "100%"
    },
    sidebar: {
        background: "rgba(0,0,0,0.2)",
        borderRight: "1px solid rgba(255,255,255,0.05)",
        padding: "32px",
        display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center"
    },
    avatar: {
        width: "120px", height: "120px", borderRadius: "50%",
        background: "linear-gradient(135deg, #6366f1 0%, #a855f7 100%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "48px", marginBottom: "24px",
        boxShadow: "0 0 40px rgba(168, 85, 247, 0.4)"
    },
    main: { padding: "40px", overflowY: "auto" },
    section: { marginBottom: "32px" },
    label: {
        fontSize: "11px", textTransform: "uppercase", letterSpacing: "1px", fontWeight: "700",
        color: "#94a3b8", marginBottom: "8px", display: "block"
    },
    input: {
        width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "8px", padding: "12px", color: "white", fontSize: "14px",
        marginBottom: "16px", fontFamily: "Inter, sans-serif"
    },
    levelGrid: {
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px", marginBottom: "16px"
    },
    levelBtn: {
        background: "rgba(255,255,255,0.05)", border: "1px solid transparent",
        borderRadius: "8px", padding: "12px", textAlign: "center", cursor: "pointer",
        color: "#cbd5e1", fontSize: "13px", fontWeight: "500", transition: "all 0.2s"
    },
    levelBtnActive: {
        background: "#3b82f6", color: "white", borderColor: "#60a5fa",
        boxShadow: "0 4px 12px rgba(59, 130, 246, 0.3)"
    }
}

export const OdieProfileModal = ({ onClose }: { onClose: () => void }) => {
    // -- STATE --
    // We need a simple re-render mechanic for tabs
    const container = <div style={{ height: "100%", width: "100%" }}></div> as HTMLElement
    let activeTab = "identity" // identity | sound | studio | goals

    // Reactive binding: We read generic DNA, but writes go to UserService
    const getDna = () => userService.dna.getValue()

    const render = () => {
        container.innerHTML = ""
        const dna = getDna()

        // -- SIDEBAR ACTIONS --
        const renderTabBtn = (id: string, label: string, icon: string) => {
            const isActive = activeTab === id
            return <div
                onclick={() => { activeTab = id; render() }}
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

        // -- TABS CONTENT --
        let tabContent
        if (activeTab === "identity") {
            tabContent = <div>
                <div style={S.section}>
                    <label style={S.label}>Artist Name / Alias</label>
                    <input type="text" value={dna.name} style={S.input}
                        onchange={(e: any) => { userService.update({ name: e.target.value }); render() }}
                    />
                </div>
                <div style={S.section}>
                    <label style={S.label}>Primary Role</label>
                    <select style={S.input} onchange={(e: any) => userService.update({ identity: { ...dna.identity, role: e.target.value } })}>
                        {["producer", "songwriter", "mixer", "sound_designer", "artist"].map(r =>
                            <option value={r} selected={dna.identity.role === r}>{r.toUpperCase().replace("_", " ")}</option>
                        )}
                    </select>
                </div>
                <div style={S.section}>
                    <label style={S.label}>Location (City/Planet)</label>
                    <input type="text" value={dna.identity.location} style={S.input}
                        onchange={(e: any) => userService.update({ identity: { ...dna.identity, location: e.target.value } })}
                    />
                </div>
                <div style={S.section}>
                    <label style={S.label}>Experience Level</label>
                    <div style={S.levelGrid}>
                        {["beginner", "intermediate", "advanced", "pro"].map(l => (
                            <div style={dna.level === l ? { ...S.levelBtn, ...S.levelBtnActive } : S.levelBtn}
                                onclick={() => { userService.update({ level: l as any }); render() }}>
                                {l.charAt(0).toUpperCase() + l.slice(1)}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        }
        else if (activeTab === "sound") {
            tabContent = <div>
                <div style={S.section}>
                    <label style={S.label}>Primary Genre</label>
                    <input type="text" value={dna.sonicFingerprint.primaryGenre} style={S.input}
                        placeholder="e.g. Melodic Techno"
                        onchange={(e: any) => userService.update({ sonicFingerprint: { ...dna.sonicFingerprint, primaryGenre: e.target.value } })}
                    />
                </div>
                <div style={S.section}>
                    <label style={S.label}>Vibe Keywords (Comma separated)</label>
                    <input type="text" value={dna.sonicFingerprint.vibeKeywords.join(", ")} style={S.input}
                        placeholder="e.g. Ethereal, Dark, Gritty"
                        onchange={(e: any) => userService.update({ sonicFingerprint: { ...dna.sonicFingerprint, vibeKeywords: e.target.value.split(",").map((s: string) => s.trim()) } })}
                    />
                </div>
                <div style={S.section}>
                    <label style={S.label}>Key Influences</label>
                    <textarea style={{ ...S.input, height: "80px", resize: "none" }}
                        placeholder="e.g. Hans Zimmer, Skrillex, Daft Punk..."
                        onchange={(e: any) => userService.update({ influences: e.target.value.split(",").map((s: string) => s.trim()) })}
                    >{dna.influences.join(", ")}</textarea>
                </div>
            </div>
        }
        else if (activeTab === "studio") {
            tabContent = <div>
                <div style={S.section}>
                    <label style={S.label}>Workflow Preference</label>
                    <select style={S.input} onchange={(e: any) => userService.update({ techRider: { ...dna.techRider, workflow: e.target.value } })}>
                        <option value="in-the-box" selected={dna.techRider.workflow === "in-the-box"}>In-The-Box (Software Only)</option>
                        <option value="hybrid" selected={dna.techRider.workflow === "hybrid"}>Hybrid (Hardware + Software)</option>
                        <option value="outboard-heavy" selected={dna.techRider.workflow === "outboard-heavy"}>Outboard Heavy (Analog)</option>
                        <option value="recording-focus" selected={dna.techRider.workflow === "recording-focus"}>Recording Focus (Live Instruments)</option>
                    </select>
                </div>
                <div style={S.section}>
                    <label style={S.label}>Studio Integrations (Hardware / Key VSTs)</label>
                    <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "8px" }}>
                        Tell Odie what else is in your studio (e.g. Moog Sub37, Serum, Push 2).
                    </div>
                    <textarea style={{ ...S.input, height: "100px", resize: "none" }}
                        placeholder="List your key gear..."
                        onchange={(e: any) => userService.update({ techRider: { ...dna.techRider, integrations: e.target.value.split(",").map((s: string) => s.trim()) } })}
                    >{dna.techRider.integrations.join(", ")}</textarea>
                </div>
            </div>
        }
        else if (activeTab === "goals") {
            tabContent = <div>
                <div style={S.section}>
                    <label style={S.label}>Current Goals</label>
                    <textarea style={{ ...S.input, height: "120px", resize: "none" }}
                        placeholder="What are you working towards? (e.g. Finish an EP, Learn Sound Design)"
                        onchange={(e: any) => userService.update({ goals: e.target.value.split(",").map((s: string) => s.trim()) })}
                    >{dna.goals.join(", ")}</textarea>
                </div>
            </div>
        }

        // -- LAYOUT ASSEMBLY --
        const layout = <div style={S.layout}>
            {/* Sidebar */}
            <div style={S.sidebar}>
                <div style={S.avatar}>{dna.name.charAt(0).toUpperCase()}</div>
                <div style={{ fontSize: "16px", fontWeight: "700", marginBottom: "4px" }}>{dna.name}</div>
                <div style={{ fontSize: "11px", color: "#64748b", marginBottom: "24px" }}>{dna.level.toUpperCase()}</div>

                <div style={{ width: "100%", textAlign: "left" }}>
                    {renderTabBtn("identity", "Identity", "🆔")}
                    {renderTabBtn("sound", "Sonic Profile", "🌊")}
                    {renderTabBtn("studio", "Tech Rider", "🎛️")}
                    {renderTabBtn("goals", "Goals", "🚀")}
                </div>

                <div style={{ marginTop: "auto", width: "100%" }}>
                    <button style={{
                        width: "100%", padding: "12px", background: "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)",
                        border: "none", borderRadius: "8px", color: "white", fontWeight: "600", cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: "8px"
                    }} onclick={() => alert("Odie Interview Mode coming soon! Chat with Odie to auto-fill this.")}>
                        <span>🎤</span> Interview Me
                    </button>
                </div>
            </div>

            {/* Main Content Area */}
            <div style={S.main}>
                <h2 style={{ fontSize: "20px", fontWeight: "700", marginBottom: "24px", color: "white", borderBottom: "1px solid #333", paddingBottom: "16px" }}>
                    {activeTab === "identity" && "Artist Identity"}
                    {activeTab === "sound" && "Sonic Fingerprint"}
                    {activeTab === "studio" && "Technical Rider"}
                    {activeTab === "goals" && "Career Goals"}
                </h2>
                {tabContent}
            </div>
        </div>

        container.appendChild(layout)
    }

    // Initial Render
    render()

    return OdieModalFrame({
        title: "Artist Passport",
        icon: "🛂", // Passport Icon
        width: "850px",
        onClose,
        children: container
    })
}
