import css from "./OdieProfile_v2.sass?inline"

import { createElement } from "@opendaw/lib-jsx"
import { OdieModalFrame } from "./components/OdieModalFrame"
import { userService } from "./services/UserService"
import { DefaultObservableValue, ObservableValue, Terminator } from "@opendaw/lib-std"
import { TextInput } from "@/ui/components/TextInput"
import { Colors } from "@opendaw/studio-enums"
import { Html } from "@opendaw/lib-dom"
import DefaultAvatarImg from "./assets/default_avatar_placeholder.png"

const className = Html.adoptStyleSheet(css, "OdieProfileModal")

export const OdieProfileModal = ({ onClose }: { onClose: () => void }) => {
    const lifecycle = new Terminator()

    // Optimistic Models
    const nameModel = new DefaultObservableValue<string>(userService.dna.getValue().name)
    const locationModel = new DefaultObservableValue<string>(userService.dna.getValue().identity.location)
    const genreModel = new DefaultObservableValue<string>(userService.dna.getValue().sonicFingerprint.primaryGenre)
    const vibesModel = new DefaultObservableValue<string>(userService.dna.getValue().sonicFingerprint.vibeKeywords.join(", "))
    const influencesModel = new DefaultObservableValue<string>(userService.dna.getValue().influences.join(", "))

    // View State
    const activeTab$ = new DefaultObservableValue<string>("overview")
    const showAvatarMenu$ = new DefaultObservableValue<boolean>(false)

    // Stable ID from UserService (persisted across sessions)
    const profileId = userService.getProfileId()

    // Sync to UserService
    lifecycle.own(nameModel.subscribe((v: ObservableValue<string>) => userService.update({ name: v.getValue() })))
    lifecycle.own(locationModel.subscribe((v: ObservableValue<string>) => userService.update({ identity: { ...userService.dna.getValue().identity, location: v.getValue() } })))
    lifecycle.own(genreModel.subscribe((v: ObservableValue<string>) => userService.update({ sonicFingerprint: { ...userService.dna.getValue().sonicFingerprint, primaryGenre: v.getValue() } })))
    lifecycle.own(vibesModel.subscribe((v: ObservableValue<string>) => userService.update({ sonicFingerprint: { ...userService.dna.getValue().sonicFingerprint, vibeKeywords: v.getValue().split(",").map(s => s.trim()) } })))
    lifecycle.own(influencesModel.subscribe((v: ObservableValue<string>) => userService.update({ influences: v.getValue().split(",").map(s => s.trim()) })))

    const container = <div className={Html.buildClassList(className, "layout")}></div> as HTMLElement

    // File Input for Avatar
    const fileInput = <input type="file" accept="image/png, image/jpeg" style={{ display: "none" }} /> as HTMLInputElement
    fileInput.onchange = (e: any) => {
        const file = e.target.files[0]
        if (file) {
            const reader = new FileReader()
            reader.onload = (evt) => {
                userService.update({ avatar: evt.target?.result as string })
                render()
            }
            reader.readAsDataURL(file)
        }
    }

    const getProfile = () => userService.dna.getValue()

    const render = () => {
        container.innerHTML = ""
        const profile = getProfile()
        const activeTab = activeTab$.getValue()

        // -- SIDEBAR ACTIONS --
        const renderTabBtn = (id: string, label: string) => {
            const isActive = activeTab === id
            return <div
                role="tab"
                aria-selected={isActive}
                onclick={() => activeTab$.setValue(id)}
                className={`nav-item ${isActive ? 'active' : ''}`}
            >
                <span>{label}</span>
            </div>
        }

        // -- TABS CONTENT --
        let tabContent

        if (activeTab === "overview") {
            const hasName = profile.name.trim().length > 0
            const displayRole = profile.identity.role.charAt(0).toUpperCase() + profile.identity.role.slice(1).replace("_", " ")
            const displayGenre = profile.sonicFingerprint.primaryGenre || "Unknown Genre"
            const influences = profile.influences.slice(0, 3).join(", ") || "None Listed"

            tabContent = <div className="overview-tab">
                <div className="profile-card" style={{ flex: "1", display: "flex", flexDirection: "column" }}>
                    <div className="profile-header">
                        <div className="profile-id" style={{ opacity: "0.5" }}>PROFILE-ID: {profileId}</div>
                        <div className="profile-status">STATUS: ACTIVE</div>
                    </div>
                    <div className="profile-body" style={{ flex: "1" }}>
                        <div className="profile-photo">
                            <div className="photo-frame" style={{
                                backgroundImage: `url(${profile.avatar || DefaultAvatarImg})`
                            }}></div>
                        </div>
                        <div className="profile-details">
                            <div className="detail-row main">
                                <div className="detail-label">IDENTITY</div>
                                <div className="detail-value highlight" style={{ fontSize: "24px" }}>{hasName ? profile.name : "ANONYMOUS"}</div>
                            </div>
                            <div className="detail-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: "24px" }}>
                                <div className="detail-row">
                                    <div className="detail-label">ROLE</div>
                                    <div className="detail-value">{displayRole}</div>
                                </div>
                                <div className="detail-row">
                                    <div className="detail-label">LEVEL</div>
                                    <div className="detail-value">{profile.level.toUpperCase()}</div>
                                </div>
                                <div className="detail-row">
                                    <div className="detail-label">LOCATION</div>
                                    <div className="detail-value">{profile.identity.location || "Unknown"}</div>
                                </div>
                            </div>
                            <div className="detail-grid" style={{ marginTop: "24px" }}>
                                <div className="detail-row">
                                    <div className="detail-label">SONIC PROFILE</div>
                                    <div className="detail-value" style={{ color: Colors.blue.toString() }}>{displayGenre}</div>
                                </div>
                                <div className="detail-row">
                                    <div className="detail-label">TOP INFLUENCES</div>
                                    <div className="detail-value" style={{ opacity: "0.8" }}>{influences}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="profile-footer">
                        <div className="issued">CREATED: 2026.01.07</div>
                    </div>
                </div>
            </div>
        }
        else if (activeTab === "identity") {
            tabContent = <div>
                <div className="section">
                    <label className="label">Artist Name / Alias</label>
                    <TextInput lifecycle={lifecycle} model={nameModel} className="profile-input" placeholder="Artist Name" />
                </div>
                <div className="section">
                    <label className="label">Primary Role</label>
                    <select className="native-input" onchange={(e: any) => userService.update({ identity: { ...profile.identity, role: e.target.value } })}>
                        {["producer", "songwriter", "mixer", "sound_designer", "artist"].map(r =>
                            <option value={r} selected={profile.identity.role === r}>{r.toUpperCase().replace("_", " ")}</option>
                        )}
                    </select>
                </div>
                <div className="section">
                    <label className="label">Location</label>
                    <TextInput lifecycle={lifecycle} model={locationModel} className="profile-input" placeholder="Location" />
                </div>
                <div className="section">
                    <label className="label">Experience Level</label>
                    <div className="level-grid">
                        {["beginner", "intermediate", "advanced", "pro"].map(l => (
                            <div className={`level-btn ${profile.level === l ? 'active' : ''}`}
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
                    <TextInput lifecycle={lifecycle} model={genreModel} className="profile-input" placeholder="e.g. Synthpop" />
                </div>
                <div className="section">
                    <label className="label">Vibe Keywords (Comma separated)</label>
                    <TextInput lifecycle={lifecycle} model={vibesModel} className="profile-input" placeholder="e.g. Dark, Cinematic, Retro" />
                </div>
                <div className="section">
                    <label className="label">Key Influences</label>
                    <TextInput lifecycle={lifecycle} model={influencesModel} className="profile-input" placeholder="e.g. Depeche Mode, Kraftwerk" />
                </div>
            </div>
        }
        else if (activeTab === "studio") {
            tabContent = <div>
                <div className="section">
                    <label className="label">Workflow Preference</label>
                    <select className="native-input" onchange={(e: any) => userService.update({ techRider: { ...profile.techRider, workflow: e.target.value } })}>
                        <option value="in-the-box" selected={profile.techRider.workflow === "in-the-box"}>In-The-Box (Software Only)</option>
                        <option value="hybrid" selected={profile.techRider.workflow === "hybrid"}>Hybrid (Hardware + Software)</option>
                        <option value="outboard-heavy" selected={profile.techRider.workflow === "outboard-heavy"}>Outboard Heavy (Analog)</option>
                        <option value="recording-focus" selected={profile.techRider.workflow === "recording-focus"}>Recording Focus (Live Instruments)</option>
                    </select>
                </div>
                <div className="section">
                    <label className="label">Studio Integrations (Hardware / Key VSTs)</label>
                    <div className="input-hint">
                        List your key gear (e.g. Moog Sub37, Serum, Push 2).
                    </div>
                    <textarea className="input-textarea"
                        placeholder="List your key gear..."
                        onchange={(e: any) => userService.update({ techRider: { ...profile.techRider, integrations: e.target.value.split(",").map((s: string) => s.trim()) } })}
                    >{profile.techRider.integrations.join(", ")}</textarea>
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
                    >{profile.goals.join(", ")}</textarea>
                </div>
            </div>
        }

        // -- LAYOUT ASSEMBLY --
        const showMenu = showAvatarMenu$.getValue()
        const avatarStyle = {
            backgroundImage: `url(${profile.avatar || DefaultAvatarImg})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            fontSize: '0'
        }

        const avatarSection = <div
            className="avatar-container"
            onmouseenter={() => showAvatarMenu$.setValue(true)}
            onmouseleave={() => showAvatarMenu$.setValue(false)}
        >
            <div className="avatar" style={avatarStyle}>
            </div>

            {showMenu && <div className="avatar-menu">
                <div className="menu-item" onclick={() => fileInput.click()}>
                    <div className="label">Upload Photo</div>
                    <div className="sub">JPG/PNG (Max 2MB)</div>
                </div>
                {profile.avatar && <div className="menu-item delete" onclick={() => {
                    userService.update({ avatar: undefined })
                    render()
                }}>
                    <div className="label">Remove</div>
                </div>}
            </div>}
        </div>

        const info = <div>
            <div className="info-name">{profile.name || "Anonymous"}</div>
            <div className="info-level">{profile.level.toUpperCase()}</div>
        </div>

        const sidebar = <div className="sidebar">
            {avatarSection}
            {info}

            <div className="nav-list">
                {renderTabBtn("overview", "Overview")}
                {renderTabBtn("identity", "Identity")}
                {renderTabBtn("sound", "Sonic Profile")}
                {renderTabBtn("studio", "Tech Rider")}
                {renderTabBtn("goals", "Goals")}
            </div>
        </div> as HTMLElement

        // Main Content Area
        const main = <div className="main">
            {activeTab !== "overview" && <h2>
                {activeTab === "identity" && "Artist Identity"}
                {activeTab === "sound" && "Sonic Profile"}
                {activeTab === "studio" && "Technical Rider"}
                {activeTab === "goals" && "Career Goals"}
            </h2>}
            {tabContent}
        </div> as HTMLElement

        container.appendChild(sidebar)
        container.appendChild(main)
    }

    // Reactive Refresh
    lifecycle.own(activeTab$.subscribe(() => render()))
    lifecycle.own(showAvatarMenu$.subscribe(() => render()))

    // Initial Render
    render()

    return OdieModalFrame({
        title: "Artist Profile",
        width: "850px",
        height: "600px",
        onClose: () => {
            lifecycle.terminate()
            onClose()
        },
        children: container
    })
}
