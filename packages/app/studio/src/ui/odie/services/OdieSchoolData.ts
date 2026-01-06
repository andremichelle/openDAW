// -----------------------------------------------------------------------------
// 🎓 THE GOLDEN STANDARD (Project Reboot)
// -----------------------------------------------------------------------------
// "No Fluff. All Signal."
// -----------------------------------------------------------------------------

import { GENERATED_CURRICULUM } from "./GeneratedCurriculum";

export interface SchoolLesson {
    id: string
    title: string
    category: "AI Co-Pilot" | "Studio Manual" | "workflow" | "tools" | "songwriting" | "production" | "mixing" | "mastering" | "theory" | "internal" | "Developer Guide" | "Device Reference"
    desc: string
    tags: string[]
    content: string // Markdown content for the lesson player
}

export const ART_CATALOG: SchoolLesson[] = [
    // 🎨 Dynamic Injection: generated_curriculum (Filtered for Art)
    ...GENERATED_CURRICULUM.filter(l => ["mixing", "production", "theory", "songwriting", "mastering"].includes(l.category)),
]

