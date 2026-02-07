import { openDB, IDBPDatabase } from 'idb';

// Simple ID generator
const generateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

export interface OdieFact {
    id: string;
    content: string;      // "User prefers distorted kicks"
    tags: string[];       // ["kick", "techno", "production"]
    confidence: number;   // 0.0 to 1.0
    timestamp: number;
    source: 'user' | 'inference' | 'web';
}

const DB_NAME = 'odie_brain_v1';
const STORE_NAME = 'facts';

class OdieMemoryService {
    private dbPromise: Promise<IDBPDatabase> | null = null;

    constructor() {
        // Initialize DB only on client side
        if (typeof window !== 'undefined') {
            this.initDB();
        }
    }

    private initDB() {
        this.dbPromise = openDB(DB_NAME, 1, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('tags', 'tags', { multiEntry: true });
                    store.createIndex('timestamp', 'timestamp');
                }
            },
        });
    }

    /**
     * Store a new Fact in the Long Term Memory
     */
    async saveFact(content: string, tags: string[], source: OdieFact['source'] = 'inference', confidence = 1.0): Promise<string> {
        if (!this.dbPromise) return "";

        const db = await this.dbPromise;
        const fact: OdieFact = {
            id: generateId(),
            content,
            tags: tags.map(t => t.toLowerCase()),
            confidence,
            timestamp: Date.now(),
            source
        };

        await db.put(STORE_NAME, fact);
        console.log(`[OdieMemory] Fact Saved`);
        return fact.id;
    }

    /**
     * Retrieve facts that match the given context tags.
     * Returns facts that have at least one matching tag.
     */
    async queryFacts(contextTags: string[]): Promise<OdieFact[]> {
        if (!this.dbPromise) return [];
        const db = await this.dbPromise;
        const tx = db.transaction(STORE_NAME, 'readonly');
        const index = tx.store.index('tags');

        const uniqueFacts = new Map<string, OdieFact>();
        const searchTags = contextTags.map(t => t.toLowerCase());

        // IDB multiEntry index allows querying by individual tag
        // We query for each tag and merge results (OR logic)
        // Ideally we would rank by relevance (number of matching tags)

        await Promise.all(searchTags.map(async (tag) => {
            const matches = await index.getAll(IDBKeyRange.only(tag));
            matches.forEach(fact => uniqueFacts.set(fact.id, fact));
        }));

        const results = Array.from(uniqueFacts.values())
            .sort((a, b) => b.timestamp - a.timestamp); // Newest first

        return results;
    }

    /**
     * Get all memories (for Debugging / Profile View)
     */
    async getAllFacts(): Promise<OdieFact[]> {
        if (!this.dbPromise) return [];
        const db = await this.dbPromise;
        return await db.getAll(STORE_NAME);
    }

    /**
     * Clear all memories (Reset Brain)
     */
    async wipeMemory(): Promise<void> {
        if (!this.dbPromise) return;
        const db = await this.dbPromise;
        await db.clear(STORE_NAME);
        console.log("[OdieMemory] Brain Wiped.");
    }
}

export const odieMemory = new OdieMemoryService();
