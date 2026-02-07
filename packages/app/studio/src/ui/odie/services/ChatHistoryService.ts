import { DefaultObservableValue } from "@opendaw/lib-std"
import { Message } from "./llm/LLMProvider"

export interface ChatSession {
    id: string
    title: string // Auto-generated summary or "Chat 1"
    timestamp: number
    messages: Message[]
}

const STORAGE_KEY = "odie_chat_history"

class ChatHistoryService {
    private static instance: ChatHistoryService

    public readonly sessions = new DefaultObservableValue<ChatSession[]>([])

    private constructor() {
        this.load()
    }

    public static getInstance(): ChatHistoryService {
        if (!ChatHistoryService.instance) {
            ChatHistoryService.instance = new ChatHistoryService()
        }
        return ChatHistoryService.instance
    }

    // -- Persistence --

    private load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY)
            if (raw) {
                const parsed = JSON.parse(raw)
                // Sort by new
                parsed.sort((a: ChatSession, b: ChatSession) => b.timestamp - a.timestamp)
                this.sessions.setValue(parsed)
            }
        } catch (e) {
            console.error("History: Load failed", e)
        }
    }

    private save() {
        try {
            const data = JSON.stringify(this.sessions.getValue())
            localStorage.setItem(STORAGE_KEY, data)
        } catch (e: any) {
            // Handle Quota Exceeded
            if (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED") {
                console.warn("History: Quota exceeded. Attempting to trim old sessions...")
                this.trimHistory()
                try {
                    // Retry save once
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.sessions.getValue()))
                    console.log("History: Save successful after trim.")
                } catch (retryErr) {
                    console.error("History: Save failed even after trim.", retryErr)
                }
            } else {
                console.error("History: Save failed", e)
            }
        }
    }

    private trimHistory() {
        const sessions = this.sessions.getValue()
        // Keep top 20 most recent sessions
        if (sessions.length > 20) {
            const trimmed = sessions.slice(0, 20)
            this.sessions.setValue(trimmed)
        } else {
            // If already small but still failing, maybe one session is huge?
            // Heavy-handed: Keep only top 5
            const emergencyTrim = sessions.slice(0, 5)
            this.sessions.setValue(emergencyTrim)
        }
    }

    // -- Actions --

    public saveSession(session: ChatSession) {
        const current = this.sessions.getValue()
        const index = current.findIndex(s => s.id === session.id)

        if (index >= 0) {
            // Update
            const updated = [...current]
            updated[index] = session
            // Move to top?
            updated.sort((a, b) => b.timestamp - a.timestamp)
            this.sessions.setValue(updated)
        } else {
            // Create
            this.sessions.setValue([session, ...current])
        }
        this.save()
    }

    public getSession(id: string): ChatSession | undefined {
        return this.sessions.getValue().find(s => s.id === id)
    }

    public deleteSession(id: string) {
        const current = this.sessions.getValue()
        const updated = current.filter(s => s.id !== id)
        this.sessions.setValue(updated)
        this.save()
    }

    public clearAll() {
        this.sessions.setValue([])
        localStorage.removeItem(STORAGE_KEY)
    }

    // Identify active session by today/yesterday/etc for grouping
    public getGroupedSessions() {
        const sessions = this.sessions.getValue()
        const grouped: Record<string, ChatSession[]> = {
            "Today": [],
            "Yesterday": [],
            "The Past": []
        }

        const now = new Date()
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
        const yesterday = today - (24 * 60 * 60 * 1000)

        sessions.forEach(s => {
            if (s.timestamp >= today) {
                grouped["Today"].push(s)
            } else if (s.timestamp >= yesterday) {
                grouped["Yesterday"].push(s)
            } else {
                grouped["The Past"].push(s)
            }
        })

        return grouped
    }
}

export const chatHistory = ChatHistoryService.getInstance()
