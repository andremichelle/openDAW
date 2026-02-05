import { openDB, DBSchema, IDBPDatabase } from "idb"
import { UUID } from "@opendaw/lib-std"

interface OdieFeedbackSchema extends DBSchema {
    feedback: {
        key: string
        value: FeedbackEntry
        indexes: { "by-rating": string }
    }
}

export interface FeedbackEntry {
    id: string
    timestamp: number
    userMessage: string
    odieResponse: string
    rating: 'positive' | 'negative'
    comment?: string
}

class OdieFeedbackService {
    private dbName = "odie-feedback"
    private dbPromise: Promise<IDBPDatabase<OdieFeedbackSchema>>

    constructor() {
        this.dbPromise = openDB<OdieFeedbackSchema>(this.dbName, 1, {
            upgrade(db) {
                const store = db.createObjectStore("feedback", { keyPath: "id" })
                store.createIndex("by-rating", "rating")
            },
        })
    }

    /**
     * Logs a user interaction and rating.
     */
    async log(entry: Omit<FeedbackEntry, "id" | "timestamp">) {
        const db = await this.dbPromise
        const fullEntry: FeedbackEntry = {
            ...entry,
            id: UUID.generate().toString(),
            timestamp: Date.now()
        }
        await db.put("feedback", fullEntry)
        console.debug("Feedback Logged")
    }

    /**
     * Exports all feedback as a JSON file download.
     */
    async export() {
        const db = await this.dbPromise
        const allFeedback = await db.getAll("feedback")

        const blob = new Blob([JSON.stringify(allFeedback, null, 2)], { type: "application/json" })
        const url = URL.createObjectURL(blob)

        const a = document.createElement("a")
        a.href = url
        a.download = `odie_feedback_${Date.now()}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)

        return allFeedback.length
    }
}

export const odieFeedback = new OdieFeedbackService()
