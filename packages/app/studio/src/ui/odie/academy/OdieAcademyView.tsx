import { createElement } from "@opendaw/lib-jsx"
import { OdiePage } from "../OdiePage"
import { DefaultObservableValue, Terminator } from "@opendaw/lib-std"
import { ART_CATALOG, SchoolLesson } from "../services/OdieSchoolData"
import { schoolStore } from "../services/SchoolStore"
import markdownit from "markdown-it"

// Categories
const CATEGORY_ICONS: Record<string, string> = {
    "songwriting": "✍️",
    "production": "🎹",
    "mixing": "🎚️",
    "mastering": "💿",
    "theory": "🧠"
}

export const OdieAcademyView = () => {
    const lifecycle = new Terminator()

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

    const renderCard = (lesson: SchoolLesson) => {
        return <div className="card"
            style={{
                padding: "16px", background: "var(--color-bg-3)",
                border: "1px solid var(--color-edge)", borderRadius: "8px",
                cursor: "pointer", transition: "border-color 0.2s"
            }}
            onclick={() => schoolStore.openLesson(lesson)}
        >
            <div style={{
                fontSize: "10px", fontWeight: "700", textTransform: "uppercase",
                color: "var(--color-text-2)", marginBottom: "8px"
            }}>
                {lesson.category}
            </div>
            <div style={{ fontSize: "16px", fontWeight: "bold", marginBottom: "8px" }}>{lesson.title}</div>
            <div style={{ fontSize: "13px", color: "var(--color-text-2)", lineHeight: "1.4" }}>{lesson.desc}</div>
        </div>
    }

    const renderLesson = (lesson: SchoolLesson) => {
        const md = markdownit({ html: true, breaks: true })
        const html = md.render(lesson.content)

        return <div className="markdown" style={{ maxWidth: "800px", margin: "0 auto" }}>
            <div
                className="link"
                style={{ marginBottom: "24px", display: "inline-block", cursor: "pointer" }}
                onclick={() => schoolStore.closeLesson()}
            >← Back to Catalog</div>

            <div style={{ marginBottom: "32px", borderBottom: "1px solid var(--color-edge)", paddingBottom: "16px" }}>
                <span className="badge">{lesson.category}</span>
                <h1 style={{ marginTop: "16px" }}>{lesson.title}</h1>
            </div>

            <div innerHTML={html} />
        </div>
    }

    const renderCatalog = (category: string | null) => {
        let lessons = ART_CATALOG
        if (category) lessons = lessons.filter(l => l.category === category)

        return <div>
            <div style={{ marginBottom: "32px" }}>
                <h1>Academy</h1>
                <p>Theory, Composition, sorting and the Soul of Music.</p>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: "16px" }}>
                {lessons.map(renderCard)}
            </div>
        </div>
    }

    const content = ObserverView(schoolStore.currentLesson, (lesson) => {
        if (lesson) {
            return renderLesson(lesson)
        }

        return ObserverView(schoolStore.selectedCategory, (category) => {
            return renderCatalog(category)
        })
    })

    const categories = [
        "songwriting", "production", "mixing", "mastering", "theory"
    ]

    return (
        <OdiePage path="/odie/academy" children={
            <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", height: "100%" }}>
                <aside style={{
                    borderRight: "1px solid var(--color-edge)",
                    padding: "20px",
                    display: "flex", flexDirection: "column", gap: "4px"
                }}>
                    <div
                        className={`local-link ${!schoolStore.selectedCategory.getValue() ? "active" : ""}`}
                        onclick={() => schoolStore.setCategory(null)}
                    >
                        ALL LESSONS
                    </div>

                    {categories.map(cat => (
                        ObserverView(schoolStore.selectedCategory, (openCat) =>
                            <div
                                className={`local-link ${openCat === cat ? "active" : ""}`}
                                onclick={() => schoolStore.setCategory(cat)}
                            >
                                {CATEGORY_ICONS[cat]} {cat.charAt(0).toUpperCase() + cat.slice(1)}
                            </div>
                        )
                    ))}
                </aside>
                <div className="content" style={{ padding: "40px", overflowY: "auto" }}>
                    {content}
                </div>
            </div>
        } />
    )
}
