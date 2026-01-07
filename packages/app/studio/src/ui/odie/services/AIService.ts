import { DefaultObservableValue, ObservableValue } from "@opendaw/lib-std"
import { LLMProvider, Message, ProviderConfig } from "./llm/LLMProvider"
import { Gemini3Provider } from "./llm/Gemini3Provider"
import { OpenAICompatibleProvider } from "./llm/OpenAICompatibleProvider"
import { ContextService } from "./ContextService"
import { ODIE_MOLECULAR_KNOWLEDGE } from "../data/OdieKnowledgeBase"

const STORAGE_KEY_CONFIGS = "odie_provider_configs"
const STORAGE_KEY_ACTIVE = "odie_provider_active" // [FIX] Uniform Key

export class AIService {
    readonly providers: LLMProvider[] = []
    readonly activeProviderId = new DefaultObservableValue<string>("gemini")
    readonly wizardCompleted = new DefaultObservableValue<boolean>(false)

    // The Brain
    readonly contextService = new ContextService()

    // Helper map to store configs in memory so we can save them
    private configMap = new Map<string, any>()

    constructor() {
        // Register Providers (The Dual Core Strategy)

        // 1. Google Gemini (Standard Intelligence & Vision)
        this.providers.push(new Gemini3Provider())

        // 3. Ollama (Local)
        const ollama = new OpenAICompatibleProvider(
            "ollama",
            "Ollama (Local)",
            "http://localhost:11434",
            false
        )
        // [ANTIGRAVITY] Auto-Heal Persistence Wiring
        ollama.onConfigChange = (newConfig) => {
            console.log(`[AIService] Persisting Auto-Healed Config for ${ollama.id}`)
            this.setConfig(ollama.id, newConfig)
        }
        this.providers.push(ollama)

        this.loadSettings()
    }

    setStudio(studio: any) {
        this.contextService.setStudio(studio)
    }

    completeWizard() {
        this.wizardCompleted.setValue(true)
        localStorage.setItem("odie_wizard_completed", "true")
    }

    resetWizard() { // Debugging helper
        this.wizardCompleted.setValue(false)
        localStorage.removeItem("odie_wizard_completed")
    }

    getProviders(): LLMProvider[] {
        return this.providers
    }

    getProvider(id: string): LLMProvider | undefined {
        return this.providers.find(p => p.id === id)
    }

    getActiveProvider(): LLMProvider | undefined {
        return this.providers.find(p => p.id === this.activeProviderId.getValue())
    }

    getConfig(providerId: string): ProviderConfig {
        return this.configMap.get(providerId) || {}
    }

    setConfig(providerId: string, config: ProviderConfig) {
        // 1. Update In-Memory Map
        this.configMap.set(providerId, config)

        // 2. Persist to Storage
        this.saveSettings()

        // 3. Notify the provider
        const provider = this.providers.find(p => p.id === providerId)
        if (provider) {
            provider.configure(config)
        }
    }

    setActiveProvider(id: string) {
        if (this.providers.find(p => p.id === id)) {
            this.activeProviderId.setValue(id)
            localStorage.setItem(STORAGE_KEY_ACTIVE, id)
        }
    }

    streamChat(messages: Message[], context?: any, tools?: any[], onFinal?: (msg: Message) => void, onStatusChange?: (status: string, model?: string) => void): ObservableValue<string> {
        const provider = this.getActiveProvider()

        // Safety check
        if (!provider) {
            console.error("No active provider found")
            return new DefaultObservableValue("Error: No AI Provider selected.")
        }

        // Ensure provider is configured before use
        const config = this.getConfig(provider.id)
        provider.configure(config)

        // 1. Get the current "Soul" of the DAW
        const dawContext = this.contextService.scan(config.modelId, config.forceAgentMode)

        // 2. Format it into a System Instruction
        const contextPrompt = `
[SYSTEM CONTEXT]
Project: ${dawContext.global.projectName}
Key: ${dawContext.global.key} | BPM: ${dawContext.global.bpm}
DNA: ${dawContext.global.dna.genre} / ${dawContext.global.dna.mood}
User Level: ${dawContext.global.dna.userLevel}

[CURRENT FOCUS]
View: ${dawContext.focus.activeView}
Active Track: ${dawContext.focus.selectedTrackName || "None"}
Plugins: ${dawContext.focus.selectedTrackPlugins?.join(", ") || "None"}

[INTERNAL KNOWLEDGE BASE]
${ODIE_MOLECULAR_KNOWLEDGE}
`

        // 3. Inject deeply
        const modifiedMessages = [...messages]
        const systemIndex = modifiedMessages.findIndex(m => m.role === 'system')

        if (systemIndex >= 0) {
            modifiedMessages[systemIndex] = {
                ...modifiedMessages[systemIndex],
                content: modifiedMessages[systemIndex].content + "\n" + contextPrompt
            }
        } else {
            // No system prompt? Create one.
            modifiedMessages.unshift({
                role: 'system',
                content: `You are Odie, an AI Assistant in OpenDAW.\n${contextPrompt}`,
                id: "system-init", // Dummy ID
                timestamp: Date.now() // Dummy timestamp
            })
        }

        // 4. Send the enriched payload WITH TOOLS
        return provider.streamChat(modifiedMessages, context, tools, onFinal, onStatusChange)
    }

    private loadSettings() {
        try {
            const rawConfigs = localStorage.getItem(STORAGE_KEY_CONFIGS)

            if (localStorage.getItem("odie_wizard_completed") === "true") {
                this.wizardCompleted.setValue(true)
            }

            if (rawConfigs) {
                const json = JSON.parse(rawConfigs)
                // Hydrate Map from JSON Object
                Object.keys(json).forEach(key => {
                    this.configMap.set(key, json[key])
                })
            }

            const active = localStorage.getItem(STORAGE_KEY_ACTIVE)
            if (active && this.providers.find(p => p.id === active)) {
                this.activeProviderId.setValue(active)
            } else {
                // [ANTIGRAVITY] Default to Gemini for new users (Local is power-user option)
                this.activeProviderId.setValue("gemini")
            }

            // AUTO-MIGRATION: Fix Mixed Content and Path issues for existing users
            const ollamaConfig = this.configMap.get("ollama")
            if (ollamaConfig) {
                // [ANTIGRAVITY] Fix: Reverted strict localhost enforcement.
                // We trust the user's config. The provider will now attempt auto-detection.

                if (!ollamaConfig.baseUrl || ollamaConfig.baseUrl.trim() === "") {
                    // Empty config? Default to standard Ollama.
                    // [ANTIGRAVITY] Use Proxy Path to avoid CORS in dev
                    ollamaConfig.baseUrl = "/api/ollama/api/chat"
                    this.configMap.set("ollama", ollamaConfig)
                    this.saveSettings()
                }

                if (ollamaConfig.baseUrl && ollamaConfig.baseUrl.includes("openrouter.ai")) {
                    console.warn("Correcting corrupted Ollama config...")
                    ollamaConfig.baseUrl = "https://openrouter.ai/api/v1/chat/completions" // Correct OpenRouter endpoint
                    this.configMap.set("ollama", ollamaConfig)
                    this.saveSettings()
                }
            }

            // Fix 4: Bad Model ID (Gemini/GPT in Ollama)
            if (this.configMap.has("ollama")) {
                const ollamaConfig = this.configMap.get("ollama")!
                if (ollamaConfig.modelId === "llama3") {
                    console.warn("Clearing legacy 'llama3' default to allow auto-detect.")
                    ollamaConfig.modelId = ""
                    this.configMap.set("ollama", ollamaConfig)
                    this.saveSettings()
                }
            } else {
                this.configMap.set("ollama", { baseUrl: "/api/ollama/api/chat", modelId: "" })
                this.saveSettings()
            }




            this.providers.forEach(p => {
                const cfg = this.configMap.get(p.id)
                if (cfg) {
                    p.configure(cfg)
                }
            })

            // [ANTIGRAVITY] REMOVED: Auto-fallback to Ollama if no key
            // This was overriding user's saved provider choice!
            // The connection indicator will show "No API" if key is missing - that's the correct UX.
            // Users can then add a key or switch providers themselves.

        } catch (e) {
            console.error("Failed to load AI settings", e)
        }
    }



    private saveSettings() {
        const obj: any = {}
        this.configMap.forEach((v, k) => obj[k] = v)
        localStorage.setItem(STORAGE_KEY_CONFIGS, JSON.stringify(obj))
    }
}
