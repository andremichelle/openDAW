import css from "./OdieProfileModal.sass?inline"

import { createElement } from "@opendaw/lib-jsx"
import { OdieModalFrame } from "./components/OdieModalFrame"
import { userService } from "./services/UserService"
import { DefaultObservableValue, ObservableValue, Terminator } from "@opendaw/lib-std"
import { Button } from "@/ui/components/Button"
import { TextInput } from "@/ui/components/TextInput"
import { Colors } from "@opendaw/studio-enums"
import { Html } from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "OdieProfileModal")

export const OdieProfileModal = ({ onClose }: { onClose: () => void }) => {
    // -- STATE --
    const lifecycle = new Terminator()
    const nameModel = new DefaultObservableValue<string>(userService.dna.getValue().name)
    const locationModel = new DefaultObservableValue<string>(userService.dna.getValue().identity.location)
    const genreModel = new DefaultObservableValue<string>(userService.dna.getValue().sonicFingerprint.primaryGenre)
    const vibesModel = new DefaultObservableValue<string>(userService.dna.getValue().sonicFingerprint.vibeKeywords.join(", "))
    const influencesModel = new DefaultObservableValue<string>(userService.dna.getValue().influences.join(", "))

    // View State
    const activeTab$ = new DefaultObservableValue<string>("identity") // identity | sound | studio | goals

    // Sync to UserService
    lifecycle.own(nameModel.subscribe((v: ObservableValue<string>) => userService.update({ name: v.getValue() })))
    lifecycle.own(locationModel.subscribe((v: ObservableValue<string>) => userService.update({ identity: { ...userService.dna.getValue().identity, location: v.getValue() } })))
    lifecycle.own(genreModel.subscribe((v: ObservableValue<string>) => userService.update({ sonicFingerprint: { ...userService.dna.getValue().sonicFingerprint, primaryGenre: v.getValue() } })))
    lifecycle.own(vibesModel.subscribe((v: ObservableValue<string>) => userService.update({ sonicFingerprint: { ...userService.dna.getValue().sonicFingerprint, vibeKeywords: v.getValue().split(",").map(s => s.trim()) } })))
    lifecycle.own(influencesModel.subscribe((v: ObservableValue<string>) => userService.update({ influences: v.getValue().split(",").map(s => s.trim()) })))

    // We need a simple re-render mechanic for tabs
    const container = <div className={Html.buildClassList(className, "layout")}></div> as HTMLElement

    // Reactive binding: We read generic DNA, but writes go to UserService
    const getDna = () => userService.dna.getValue()

    const render = () => {
        container.innerHTML = ""
        const dna = getDna()
        const activeTab = activeTab$.getValue()

        // -- SIDEBAR ACTIONS --
        const renderTabBtn = (id: string, label: string) => {
            const isActive = activeTab === id
            return <div
                onclick={() => activeTab$.setValue(id)}
                className={`nav-item ${isActive ? 'active' : ''}`}
            >
                <span>{label}</span>
            </div>
        }

        // -- TABS CONTENT --
        let tabContent
        if (activeTab === "identity") {
            tabContent = <div>
                <div className="section">
                    <label className="label">Artist Name / Alias</label>
                    <TextInput lifecycle={lifecycle} model={nameModel} className="profile-input" />
                </div>
                <div className="section">
                    <label className="label">Primary Role</label>
                    <select className="native-input" onchange={(e: any) => userService.update({ identity: { ...dna.identity, role: e.target.value } })}>
                        {["producer", "songwriter", "mixer", "sound_designer", "artist"].map(r =>
                            <option value={r} selected={dna.identity.role === r}>{r.toUpperCase().replace("_", " ")}</option>
                        )}
                    </select>
                </div>
                <div className="section">
                    <label className="label">Location (City/Planet)</label>
                    <TextInput lifecycle={lifecycle} model={locationModel} className="profile-input" />
                </div>
                <div className="section">
                    <label className="label">Experience Level</label>
                    <div className="level-grid">
                        {["beginner", "intermediate", "advanced", "pro"].map(l => (
                            <div className={`level-btn ${dna.level === l ? 'active' : ''}`}
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
                <div className="section">
                    <label className="label">Primary Genre</label>
                    <TextInput lifecycle={lifecycle} model={genreModel} className="profile-input" />
                </div>
                <div className="section">
                    <label className="label">Vibe Keywords (Comma separated)</label>
                    <TextInput lifecycle={lifecycle} model={vibesModel} className="profile-input" />
                </div>
                <div className="section">
                    <label className="label">Key Influences</label>
                    <TextInput lifecycle={lifecycle} model={influencesModel} className="profile-input" />
                </div>
            </div>
        }
        else if (activeTab === "studio") {
            tabContent = <div>
                <div className="section">
                    <label className="label">Workflow Preference</label>
                    <select className="native-input" onchange={(e: any) => userService.update({ techRider: { ...dna.techRider, workflow: e.target.value } })}>
                        <option value="in-the-box" selected={dna.techRider.workflow === "in-the-box"}>In-The-Box (Software Only)</option>
                        <option value="hybrid" selected={dna.techRider.workflow === "hybrid"}>Hybrid (Hardware + Software)</option>
                        <option value="outboard-heavy" selected={dna.techRider.workflow === "outboard-heavy"}>Outboard Heavy (Analog)</option>
                        <option value="recording-focus" selected={dna.techRider.workflow === "recording-focus"}>Recording Focus (Live Instruments)</option>
                    </select>
                </div>
                <div className="section">
                    <label className="label">Studio Integrations (Hardware / Key VSTs)</label>
                    <div className="input-hint">
                        Tell Odie what else is in your studio (e.g. Moog Sub37, Serum, Push 2).
                    </div>
                    <textarea className="input-textarea"
                        placeholder="List your key gear..."
                        onchange={(e: any) => userService.update({ techRider: { ...dna.techRider, integrations: e.target.value.split(",").map((s: string) => s.trim()) } })}
                    >{dna.techRider.integrations.join(", ")}</textarea>
                </div>
            </div>
        }
        else if (activeTab === "goals") {
            tabContent = <div>
                <div className="section">
                    <label className="label">Current Goals</label>
                    <textarea className="input-textarea" style={{ height: "120px" }}
                        placeholder="What are you working towards? (e.g. Finish an EP, Learn Sound Design)"
                        onchange={(e: any) => userService.update({ goals: e.target.value.split(",").map((s: string) => s.trim()) })}
                    >{dna.goals.join(", ")}</textarea>
                </div>
            </div>
        }

        // -- LAYOUT ASSEMBLY --
        const avatar = <div className="avatar">{dna.name.charAt(0).toUpperCase()}</div>
        const info = <div>
            <div className="info-name">{dna.name}</div>
            <div className="info-level">{dna.level.toUpperCase()}</div>
        </div>

        const sidebar = <div className="sidebar">
            {avatar}
            {info}

            <div className="nav-list">
                {renderTabBtn("identity", "Identity")}
                {renderTabBtn("sound", "Sonic Profile")}
                {renderTabBtn("studio", "Tech Rider")}
                {renderTabBtn("goals", "Goals")}
            </div>

            <div className="action-area">
                <Button
                    lifecycle={lifecycle}
                    appearance={{ framed: true, color: Colors.blue }}
                    /* Style override is needed for Button wrapper specific width */
                    style={{ width: "100%", padding: "12px", height: "40px" }}
                    onClick={() => alert("Odie Interview Mode coming soon! Chat with Odie to auto-fill this.")}>
                    Interview Me
                </Button>
            </div>
        </div> as HTMLElement

        // Main Content Area
        const main = <div className="main">
            <h2>
                {activeTab === "identity" && "Artist Identity"}
                {activeTab === "sound" && "Sonic Fingerprint"}
                {activeTab === "studio" && "Technical Rider"}
                {activeTab === "goals" && "Career Goals"}
            </h2>
            {tabContent}
        </div> as HTMLElement

        container.appendChild(sidebar)
        container.appendChild(main)
    }

    // Reactive Refresh
    lifecycle.own(activeTab$.subscribe(() => render()))
    // Also re-render if user details change (which they do via the updates)
    // In a real app we might want to subscribe to userService.dna, but here updates are local-optimistic via models

    // Initial Render
    render()

    return OdieModalFrame({
        title: "Artist Passport",
        width: "850px",
        height: "600px",
        onClose: () => {
            lifecycle.terminate()
            onClose()
        },
        children: container
    })
}
