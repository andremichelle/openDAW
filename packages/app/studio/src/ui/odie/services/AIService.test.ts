import { describe, it, expect, beforeEach } from 'vitest'
import { AIService } from './AIService'

describe('AIService', () => {
    beforeEach(() => {
        global.localStorage = {
            store: {} as Record<string, string>,
            getItem(key: string) { return this.store[key] || null },
            setItem(key: string, value: string) { this.store[key] = value },
            removeItem(key: string) { delete this.store[key] },
            clear() { this.store = {} },
            key(n: number) { return Object.keys(this.store)[n] },
            length: 0
        } as any
    })

    it('should register core providers on initialization', () => {
        const service = new AIService()
        expect(service.providers.length).toBe(2)

        const ids = service.providers.map(p => p.id)
        expect(ids).toContain('ollama')
        expect(ids).toContain('gemini-3')
    })

    it('should apply smart defaults for Ollama provider', () => {
        const service = new AIService()

        const ollamaConfig = service.getConfig('ollama')
        // Ollama uses the proxy path
        expect(ollamaConfig.baseUrl).toBe('/api/ollama')
    })

    it('should allow switching active provider', () => {
        const service = new AIService()
        service.setActiveProvider('gemini-3')
        expect(service.getActiveProvider()?.id).toBe('gemini-3')
    })
})
