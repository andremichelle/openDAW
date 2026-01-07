import { createElement } from "@opendaw/lib-jsx"
import markdownit from "markdown-it"
import { Terminator } from "@opendaw/lib-std"
import { OdieModalFrame } from "./components/OdieModalFrame"
import { ART_CATALOG, SchoolLesson } from "./services/OdieSchoolData"
import { SchoolBridge } from "./services/SchoolBridge"
import { schoolStore } from "./services/SchoolStore"
import { OdieSchoolStyles } from "./services/SchoolStyles"
import { OdieChat } from "./OdieChat"

const CATEGORY_COLORS: Record<string, string> = {
    "songwriting": "#a855f7", // Purple
    "production": "#3b82f6",  // Blue
    "mixing": "#22c55e",      // Green
    "mastering": "#ef4444",   // Red
    "theory": "#f59e0b"       // Amber
}

export const OdieSchoolModal = ({ service, onClose }: { service: any, onClose: () => void }) => {
    const lifecycle = new Terminator()

    // Initialize Bridge
    SchoolBridge.getInstance().connect(service)

    // Force mode to 'art' initially to skip the old Home
    schoolStore.setMode("art")

    // Main Container
    const container = <div className="odie-school-container">
        <style>{OdieSchoolStyles}</style>
    </div> as HTMLElement

    // -- RENDERERS --

    const renderCard = (lesson: SchoolLesson) => {
        const color = CATEGORY_COLORS[lesson.category] || "#64748b"
        return <div className="school-card"
            onclick={() => schoolStore.openLesson(lesson)}
        >
            <div style={{ padding: "4px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "700", textTransform: "uppercase", alignSelf: "start", background: `${color}20`, color: color }}>
                {lesson.category}
            </div>
            <div style={{ fontSize: "16px", fontWeight: "700", color: "white", marginBottom: "8px" }}>{lesson.title}</div>
            <div style={{ fontSize: "13px", color: "#94a3b8", lineHeight: "1.5" }}>{lesson.desc}</div>
        </div>
    }

    const renderDashboard = () => {
        const selectedCat = schoolStore.selectedCategory.getValue()
        const query = schoolStore.searchQuery.getValue().toLowerCase()

        let lessons = ART_CATALOG
        if (selectedCat) lessons = lessons.filter(l => l.category === selectedCat)
        if (query) lessons = lessons.filter(l => l.title.toLowerCase().includes(query))

        // LANDING VIEW (Categories)
        if (!selectedCat && !query) {
            return <div style={{ padding: "32px", overflowY: "auto", flex: "1" }}>
                <div style={{ marginBottom: "32px", textAlign: "center" }}>
                    <div style={{ fontSize: "32px", marginBottom: "8px" }}>🎨</div>
                    <div style={{ fontSize: "24px", fontWeight: "700", color: "white" }}>Odie Arts Academy</div>
                    <div style={{ color: "#94a3b8", marginTop: "8px" }}>Theory, Composition, Sorting and the Soul of Music.</div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "24px", paddingBottom: "40px" }}>
                    {[
                        { id: "songwriting", icon: "✍️", label: "Songwriting", color: "#ec4899" },
                        { id: "production", icon: "🎹", label: "Production", color: "#8b5cf6" },
                        { id: "mixing", icon: "🎚️", label: "Mixing", color: "#3b82f6" },
                        { id: "mastering", icon: "💿", label: "Mastering", color: "#ef4444" },
                        { id: "theory", icon: "🧠", label: "Music Theory", color: "#f59e0b" }
                    ].map(cat => <div className="cat-card"
                        style={{ borderTop: `4px solid ${cat.color}` }}
                        onclick={() => schoolStore.setCategory(cat.id)}>
                        <div style={{ fontSize: "40px" }}>{cat.icon}</div>
                        <div style={{ fontSize: "18px", fontWeight: "700", marginTop: "16px" }}>{cat.label}</div>
                    </div>)}
                </div>
            </div>
        }

        // CATEGORY / SEARCH VIEW
        return <div style={{ padding: "32px", overflowY: "auto", flex: "1" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
                <div style={{ cursor: "pointer", color: "#94a3b8", fontWeight: "600", fontSize: "13px", display: "flex", alignItems: "center", gap: "6px" }}
                    onclick={() => schoolStore.setCategory(null)}>
                    <span>←</span> Back to Disciplines
                </div>
                {selectedCat && <span style={{ color: "#e2e8f0", fontWeight: "700", fontSize: "18px" }}>/ {selectedCat.toUpperCase()}</span>}
            </div>
            <div className="school-grid" style={{ padding: "0" }}>
                {lessons.map(renderCard)}
            </div>
        </div>
    }

    const renderPlayer = () => {
        const lesson = schoolStore.currentLesson.getValue()
        if (!lesson) return null
        const md = markdownit({ html: true, breaks: true })
        const html = md.render(lesson.content)

        return <div style={{ padding: "40px", overflowY: "auto", flex: "1", color: "#e2e8f0", lineHeight: "1.8", maxWidth: "900px", margin: "0 auto" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#94a3b8", cursor: "pointer", marginBottom: "16px", fontWeight: "600" }}
                onclick={() => schoolStore.closeLesson()}
            >← Exit Lesson</div>

            <div style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", paddingBottom: "24px", marginBottom: "32px" }}>
                <div style={{ display: "inline-block", padding: "4px 8px", borderRadius: "4px", background: "#3b82f620", color: "#3b82f6", marginBottom: "16px", fontSize: "10px", fontWeight: "700", textTransform: "uppercase" }}>
                    {lesson.category}
                </div>
                <div style={{ fontSize: "24px", fontWeight: "700", color: "white", marginBottom: "8px" }}>{lesson.title}</div>
                <div style={{ fontSize: "14px", color: "#94a3b8" }}>{lesson.desc}</div>
            </div>

            <div className="school-content" innerHTML={html} />
        </div>
    }

    // -- HEADER UPDATER --
    const updateHeader = () => {
        const slot = document.getElementById("school-header-controls")
        if (!slot) return

        const mode = schoolStore.activeMode.getValue()
        const query = schoolStore.searchQuery.getValue()

        slot.innerHTML = ""
        if (mode === "player") return // Clean header for reading

        // Simple Search Header - No Tabs
        const controls = <div className="school-header-controls" style={{ justifyContent: "flex-end" }}>
            <input type="text" className="school-search-bar" placeholder="🔍 Find..."
                value={query}
                oninput={(e: any) => schoolStore.setSearch(e.target.value)}
            />
        </div>
        slot.appendChild(controls)
    }

    // -- MAIN RENDER LOOP --
    const render = () => {
        const mode = schoolStore.activeMode.getValue()

        let contentWrapper = container.querySelector("#school-content-wrapper")
        if (!contentWrapper) {
            const newWrapper = <div id="school-content-wrapper" style={{ height: "100%", width: "100%" }}></div> as HTMLElement
            container.appendChild(newWrapper)
            contentWrapper = newWrapper
        }

        if (contentWrapper) {
            contentWrapper.innerHTML = ""

            // 2. Build Layout
            const layout = <div className="school-split-view">
                <div className="school-library">
                    {mode === "player" ? renderPlayer() : renderDashboard()}
                </div>
                {/* Chat: Real Instance */}
                <div style={{
                    background: "#0f1115", display: "flex", flexDirection: "column",
                    borderLeft: "1px solid rgba(255,255,255,0.05)",
                    position: "relative",
                    overflow: "hidden"
                }}>
                    {OdieChat({ service: service })}
                </div>
            </div>

            contentWrapper.appendChild(layout)
            updateHeader()
        }
    }

    // -- SUBSCRIPTIONS --
    // We treat 'app' or 'home' modes as essentially just 'dashboard' (art) for now
    lifecycle.own(schoolStore.activeMode.subscribe(() => render()))
    lifecycle.own(schoolStore.searchQuery.subscribe(() => { render(); updateHeader() }))
    lifecycle.own(schoolStore.currentLesson.subscribe(() => render()))
    lifecycle.own(schoolStore.selectedCategory.subscribe(() => render()))

    // Initial Render
    setTimeout(() => render(), 0)

    return OdieModalFrame({
        title: "Odie Arts Academy",
        icon: "🎓",
        width: "90vw",
        height: "90vh",
        position: "center",
        onClose: () => {
            const ctxMenu = document.getElementById("school-context-menu")
            if (ctxMenu) ctxMenu.remove()
            lifecycle.terminate()
            onClose()
        },
        headerContent: <div id="school-header-controls"></div>,
        children: container
    })
}
