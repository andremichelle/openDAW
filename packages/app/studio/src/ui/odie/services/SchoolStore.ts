import { DefaultObservableValue } from "@opendaw/lib-std"
import { SchoolLesson } from "./OdieSchoolData"

export type SchoolMode = "home" | "app" | "art" | "player"

export interface ZoneInfo {
    title: string
    desc: string
}

class SchoolStore {
    private static instance: SchoolStore

    public readonly activeMode = new DefaultObservableValue<SchoolMode>("home")
    public readonly searchQuery = new DefaultObservableValue<string>("")
    public readonly currentLesson = new DefaultObservableValue<SchoolLesson | null>(null)
    public readonly hoveredZone = new DefaultObservableValue<ZoneInfo | null>(null)
    public readonly selectedCategory = new DefaultObservableValue<string | null>(null)

    public readonly contextMenu = new DefaultObservableValue<{
        visible: boolean,
        x: number,
        y: number,
        menuId: string | null
    }>({ visible: false, x: 0, y: 0, menuId: null })

    // Persistence
    public readonly completedLessonIds = new DefaultObservableValue<string[]>([])

    private constructor() {
        this.loadState()
    }

    public static getInstance(): SchoolStore {
        if (!SchoolStore.instance) {
            SchoolStore.instance = new SchoolStore()
        }
        return SchoolStore.instance
    }

    // -- PERSISTENCE --

    private loadState() {
        try {
            const raw = localStorage.getItem("odie_school_progress")
            if (raw) {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed)) {
                    this.completedLessonIds.setValue(parsed)
                }
            }
        } catch (e) {
            console.error("SchoolStore: Failed to load progress", e)
        }
    }

    private saveState() {
        try {
            localStorage.setItem("odie_school_progress", JSON.stringify(this.completedLessonIds.getValue()))
        } catch (e) {
            console.warn("SchoolStore: Failed to save progress", e)
        }
    }

    public markLessonComplete(lessonId: string) {
        const current = this.completedLessonIds.getValue()
        if (!current.includes(lessonId)) {
            const up = [...current, lessonId]
            this.completedLessonIds.setValue(up)
            this.saveState()
        }
    }

    public isLessonComplete(lessonId: string): boolean {
        return this.completedLessonIds.getValue().includes(lessonId)
    }

    // -- ACTIONS --

    public setMode(mode: SchoolMode) {
        this.activeMode.setValue(mode)
        this.closeContextMenu()
        // Reset transient states when switching major modes
        if (mode === "home") {
            this.searchQuery.setValue("")
            this.selectedCategory.setValue(null)
        }
    }

    public openLesson(lesson: SchoolLesson) {
        this.currentLesson.setValue(lesson)
        this.activeMode.setValue("player")
        this.closeContextMenu()
    }

    public closeLesson() {
        this.currentLesson.setValue(null)
        this.activeMode.setValue("art")
    }

    public setSearch(query: string) {
        this.searchQuery.setValue(query)
        this.closeContextMenu()
        // Auto-switch to app/list mode if searching from home/art
        const currentMode = this.activeMode.getValue()
        if (query && (currentMode === "home" || currentMode === "art")) {
            this.activeMode.setValue("app")
        }
    }

    public updateLessonContent(newMarkdown: string) {
        const current = this.currentLesson.getValue()
        if (current) {
            // Immutable update to trigger Reactivity
            this.currentLesson.setValue({
                ...current,
                content: newMarkdown
            })
        }
    }

    public setCategory(cat: string | null) {
        this.selectedCategory.setValue(cat)
    }

    public setHoveredZone(zone: ZoneInfo | null) {
        // Optimize: Don't notify if same
        const current = this.hoveredZone.getValue()
        if (current?.title === zone?.title && current?.desc === zone?.desc) return
        this.hoveredZone.setValue(zone)
    }

    public openContextMenu(menuId: string, x: number, y: number) {
        this.contextMenu.setValue({ visible: true, x, y, menuId })
    }

    public closeContextMenu() {
        this.contextMenu.setValue({ visible: false, x: 0, y: 0, menuId: null })
    }
}

export const schoolStore = SchoolStore.getInstance()
