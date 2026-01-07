import { createElement } from "@opendaw/lib-jsx"
import { OdiePage } from "../OdiePage"
import { userService } from "../services/UserService"
import { DefaultObservableValue, ObservableValue, Terminator } from "@opendaw/lib-std"
import { Button } from "@/ui/components/Button"
import { TextInput } from "@/ui/components/TextInput"
import { Colors } from "@opendaw/studio-enums"

export const OdieProfileView = () => {
    // -- STATE --
    const lifecycle = new Terminator()
    const nameModel = new DefaultObservableValue<string>(userService.dna.getValue().name)
    const locationModel = new DefaultObservableValue<string>(userService.dna.getValue().identity.location)
    const genreModel = new DefaultObservableValue<string>(userService.dna.getValue().sonicFingerprint.primaryGenre)
    const vibesModel = new DefaultObservableValue<string>(userService.dna.getValue().sonicFingerprint.vibeKeywords.join(", "))
    const influencesModel = new DefaultObservableValue<string>(userService.dna.getValue().influences.join(", "))

    // Sync to UserService
    nameModel.subscribe((v: ObservableValue<string>) => userService.update({ name: v.getValue() }))
    locationModel.subscribe((v: ObservableValue<string>) => userService.update({ identity: { ...userService.dna.getValue().identity, location: v.getValue() } }))
    genreModel.subscribe((v: ObservableValue<string>) => userService.update({ sonicFingerprint: { ...userService.dna.getValue().sonicFingerprint, primaryGenre: v.getValue() } }))
    vibesModel.subscribe((v: ObservableValue<string>) => userService.update({ sonicFingerprint: { ...userService.dna.getValue().sonicFingerprint, vibeKeywords: v.getValue().split(",").map(s => s.trim()) } }))
    influencesModel.subscribe((v: ObservableValue<string>) => userService.update({ influences: v.getValue().split(",").map(s => s.trim()) }))

    // Helper for dynamic rendering
    const ObserverView = (
        observable: DefaultObservableValue<any>,
        renderer: (val: any) => HTMLElement
    ) => {
        const container = document.createElement("div")
        lifecycle.own(observable.subscribe(val => {
            container.innerHTML = ""
            const content = renderer(val)
            if (content) container.appendChild(content)
        }))
        const initialVal = observable.getValue()
        if (initialVal !== undefined) {
            const content = renderer(initialVal)
            if (content) container.appendChild(content)
        }
        return container
    }

    const activeTab = new DefaultObservableValue("identity") // identity | sound | studio | goals

    const renderTabBtn = (id: string, label: string) => {
        return ObserverView(activeTab, (current) => {
            const isActive = current === id
            return <div
                className={`local-link ${isActive ? "active" : ""}`}
                onclick={() => activeTab.setValue(id)}
            >
                {label}
            </div>
        })
    }

    const dna = userService.dna.getValue()

    const content = ObserverView(activeTab, (tab) => {
        const currentDna = userService.dna.getValue() // This might need a subscription if we want live updates from outside, but for now getting value is fine for tab switch

        let tabContent
        if (tab === "identity") {
            tabContent = <div>
                <h2>Artist Identity</h2>
                <p>Who you are as an artist.</p>
                <hr />

                <div style={{ marginBottom: "20px" }}>
                    <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Artist Name / Alias</label>
                    <TextInput lifecycle={lifecycle} model={nameModel} />
                </div>

                <div style={{ marginBottom: "20px" }}>
                    <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Primary Role</label>
                    <div className="select-wrapper">
                        <select
                            style={{
                                width: "100%", padding: "8px", borderRadius: "4px",
                                background: "var(--color-bg-3)", color: "var(--color-text-1)",
                                border: "1px solid var(--color-edge)"
                            }}
                            onchange={(e: any) => userService.update({ identity: { ...currentDna.identity, role: e.target.value } })}
                        >
                            {["producer", "songwriter", "mixer", "sound_designer", "artist"].map(r =>
                                <option value={r} selected={currentDna.identity.role === r}>{r.toUpperCase().replace("_", " ")}</option>
                            )}
                        </select>
                    </div>
                </div>

                <div style={{ marginBottom: "20px" }}>
                    <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Location (City/Planet)</label>
                    <TextInput lifecycle={lifecycle} model={locationModel} />
                </div>

                <div style={{ marginBottom: "20px" }}>
                    <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Experience Level</label>
                    <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                        {["beginner", "intermediate", "advanced", "pro"].map(l => (
                            <Button
                                lifecycle={lifecycle}
                                appearance={{
                                    framed: currentDna.level === l,
                                    color: currentDna.level === l ? Colors.blue : undefined
                                }}
                                onClick={() => {
                                    userService.update({ level: l as any })
                                    // Trigger re-render by toggling tab slightly or we rely on re-opening. 
                                    // ideally we'd subscribe to user service changes but for now this is ok.
                                    activeTab.setValue("identity")
                                }}>
                                {l.charAt(0).toUpperCase() + l.slice(1)}
                            </Button>
                        ))}
                    </div>
                </div>
            </div>
        } else if (tab === "sound") {
            tabContent = <div>
                <h2>Sonic Fingerprint</h2>
                <p>Define your musical aesthetic.</p>
                <hr />
                <div style={{ marginBottom: "20px" }}>
                    <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Primary Genre</label>
                    <TextInput lifecycle={lifecycle} model={genreModel} />
                </div>
                <div style={{ marginBottom: "20px" }}>
                    <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Vibe Keywords</label>
                    <TextInput lifecycle={lifecycle} model={vibesModel} />
                </div>
                <div style={{ marginBottom: "20px" }}>
                    <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Key Influences</label>
                    <TextInput lifecycle={lifecycle} model={influencesModel} />
                </div>
            </div>
        } else if (tab === "studio") {
            tabContent = <div>
                <h2>Technical Rider</h2>
                <p>Your production environment.</p>
                <hr />
                <div style={{ marginBottom: "20px" }}>
                    <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Workflow Preference</label>
                    <select
                        style={{
                            width: "100%", padding: "8px", borderRadius: "4px",
                            background: "var(--color-bg-3)", color: "var(--color-text-1)",
                            border: "1px solid var(--color-edge)"
                        }}
                        onchange={(e: any) => userService.update({ techRider: { ...currentDna.techRider, workflow: e.target.value } })}
                    >
                        <option value="in-the-box" selected={currentDna.techRider.workflow === "in-the-box"}>In-The-Box (Software Only)</option>
                        <option value="hybrid" selected={currentDna.techRider.workflow === "hybrid"}>Hybrid (Hardware + Software)</option>
                        <option value="outboard-heavy" selected={currentDna.techRider.workflow === "outboard-heavy"}>Outboard Heavy (Analog)</option>
                        <option value="recording-focus" selected={currentDna.techRider.workflow === "recording-focus"}>Recording Focus (Live Instruments)</option>
                    </select>
                </div>
                <div style={{ marginBottom: "20px" }}>
                    <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Studio Integrations</label>
                    <textarea
                        style={{
                            width: "100%", height: "100px", borderRadius: "4px", padding: "8px",
                            background: "var(--color-bg-3)", color: "var(--color-text-1)",
                            border: "1px solid var(--color-edge)", resize: "none"
                        }}
                        placeholder="List your key gear..."
                        onchange={(e: any) => userService.update({ techRider: { ...currentDna.techRider, integrations: e.target.value.split(",").map((s: string) => s.trim()) } })}
                    >{currentDna.techRider.integrations.join(", ")}</textarea>
                </div>
            </div>
        } else if (tab === "goals") {
            tabContent = <div>
                <h2>Current Goals</h2>
                <p>What are you working towards?</p>
                <hr />
                <div style={{ marginBottom: "20px" }}>
                    <textarea
                        style={{
                            width: "100%", height: "120px", borderRadius: "4px", padding: "8px",
                            background: "var(--color-bg-3)", color: "var(--color-text-1)",
                            border: "1px solid var(--color-edge)", resize: "none"
                        }}
                        placeholder="e.g. Finish an EP, Learn Sound Design..."
                        onchange={(e: any) => userService.update({ goals: e.target.value.split(",").map((s: string) => s.trim()) })}
                    >{currentDna.goals.join(", ")}</textarea>
                </div>
            </div>
        }

        return <div className="markdown">
            {tabContent}
        </div>
    })

    return (
        <OdiePage path="/odie/profile" children={
            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", height: "100%" }}>
                <aside style={{
                    borderRight: "1px solid var(--color-edge)",
                    padding: "20px",
                    display: "flex", flexDirection: "column", gap: "4px"
                }}>
                    <div style={{
                        width: "64px", height: "64px", borderRadius: "50%",
                        background: "var(--color-bg-3)", border: "1px solid var(--color-edge)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: "24px", marginBottom: "16px", alignSelf: "center"
                    }}>
                        {dna.name.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ textAlign: "center", fontWeight: "bold", marginBottom: "24px" }}>
                        {dna.name}
                    </div>

                    {renderTabBtn("identity", "Identity")}
                    {renderTabBtn("sound", "Sonic Profile")}
                    {renderTabBtn("studio", "Tech Rider")}
                    {renderTabBtn("goals", "Goals")}
                </aside>
                <div className="content" style={{ padding: "40px", overflowY: "auto" }}>
                    {content}
                </div>
            </div>
        } />
    )
}
