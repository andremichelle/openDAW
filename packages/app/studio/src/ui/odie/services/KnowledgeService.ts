
import { DefaultObservableValue } from "@opendaw/lib-std"
import { SchoolLesson, ART_CATALOG } from "./OdieSchoolData"
import { Manuals, Manual } from "@/ui/pages/Manuals"

// Using shared type definition
type Lesson = SchoolLesson

export class KnowledgeService {
    // State
    readonly lessons = new DefaultObservableValue<Lesson[]>([])
    readonly isReady = new DefaultObservableValue<boolean>(false)

    constructor() {
        this.initialize()
    }

    private async initialize() {
        console.log("📘 KnowledgeService: Initializing...")
        try {
            // 1. Flatten Manuals Registry
            const manualPaths: { label: string, path: string }[] = []
            const traverse = (items: ReadonlyArray<Manual>) => {
                for (const item of items) {
                    if (item.type === "page") {
                        manualPaths.push({ label: item.label, path: item.path })
                    } else if (item.type === "folder") {
                        traverse(item.files)
                    }
                }
            }
            traverse(Manuals)

            // 2. Fetch All Manuals (Parallel)
            console.log(`📘 KnowledgeService: Fetching ${manualPaths.length} manuals...`)
            const fetchedLessons = await Promise.all(manualPaths.map(async (m) => {
                try {
                    // Assuming public path structure matches Manuals.ts paths + .md
                    // e.g. /manuals/mixer -> /manuals/mixer.md
                    // Note: In dev/prod, public assets are served at root.
                    const url = `${m.path}.md`
                    const response = await fetch(url)
                    if (!response.ok) {
                        console.warn(`⚠️ Failed to fetch manual: ${url} `)
                        return null
                    }
                    const text = await response.text()
                    return this.parseLesson(m.path, text)
                } catch (e) {
                    console.error(`❌ Error fetching manual ${m.path}: `, e)
                    return null
                }
            }))

            // 3. Filter success & Merge with Art Catalog
            const validManuals = fetchedLessons.filter(l => l !== null) as Lesson[]

            // Combine: Art (Static) + Manuals (Dynamic)
            const all = [...ART_CATALOG, ...validManuals]

            this.lessons.setValue(all)
            this.isReady.setValue(true)
            console.log(`📘 KnowledgeService: Ready! Loaded ${all.length} lessons(${validManuals.length} manuals).`)

        } catch (e) {
            console.error("🔥 KnowledgeService Init Failed:", e)
        }
    }

    private parseLesson(path: string, rawContent: string): Lesson {
        // Simple YAML Frontmatter Parser
        // We look for content between first two --- lines
        const match = rawContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)

        if (match) {
            const yaml = match[1]
            const body = match[2]

            // Parse Key-Values
            // (Skipping primitive parsing in favor of regex)

            // Re-parsing using Regex for robustness against multi-line tags
            const titleMatch = yaml.match(/title:\s*(.+)/)
            const categoryMatch = yaml.match(/category:\s*(.+)/)
            const descMatch = yaml.match(/desc:\s*(.+)/)

            // Extract tags loop
            const tags: string[] = []
            let capturingTags = false
            yaml.split("\n").forEach(line => {
                if (line.trim().startsWith("tags:")) {
                    capturingTags = true
                    return
                }
                if (capturingTags) {
                    const tagMatch = line.match(/^\s*-\s*(.+)/)
                    if (tagMatch) {
                        tags.push(tagMatch[1].trim())
                    } else if (line.trim().includes(":")) {
                        // New key found
                        capturingTags = false
                    }
                }
            })

            const id = path.split("/").pop() || "unknown" // using filename as ID

            return {
                id: id,
                title: titleMatch ? titleMatch[1].trim() : "Untitled",
                category: (categoryMatch ? categoryMatch[1].trim() : "Studio Manual") as any,
                desc: descMatch ? descMatch[1].trim() : "",
                tags: tags,
                content: body
            }
        }

        // Fallback if no frontmatter
        return {
            id: path.split("/").pop() || "unknown",
            title: "Untitled",
            category: "Studio Manual",
            desc: "No description available.",
            tags: [],
            content: rawContent
        }
    }

    public getCatalog(): Lesson[] {
        return this.lessons.getValue()
    }

    public getLesson(id: string): Lesson | undefined {
        return this.lessons.getValue().find(l => l.id === id)
    }

    public findRelevantContext(query: string): string {
        // Basic keyword search
        if (!query) return ""
        const q = query.toLowerCase()
        const hits = this.lessons.getValue().filter(l =>
            l.title.toLowerCase().includes(q) ||
            l.tags.some(t => t.includes(q)) ||
            l.desc.toLowerCase().includes(q)
        )

        // Return top 2 contexts, truncated
        return hits.slice(0, 2).map(h =>
            `SOURCE: ${h.title} \n${h.content.substring(0, 500)}...`
        ).join("\n\n")
    }
}

export const knowledgeService = new KnowledgeService()
