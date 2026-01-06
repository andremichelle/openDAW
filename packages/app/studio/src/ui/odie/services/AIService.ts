import { DefaultObservableValue, ObservableValue } from "@opendaw/lib-std"
import { LLMProvider, Message, ProviderConfig } from "./llm/LLMProvider"
import { GeminiProvider } from "./llm/GeminiProvider"
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

        // 1. Gemini V1 (Legacy / Stable / System 1)
        this.providers.push(new GeminiProvider())

        // 2. Gemini V3 (Cognitive / Experimental / System 2)
        this.providers.push(new Gemini3Provider())

        // 3. Ollama (Local)
        this.providers.push(new OpenAICompatibleProvider(
            "ollama",
            "Ollama (Local)",
            "/api/ollama/api/chat",
            false
        ))

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
                this.activeProviderId.setValue("ollama")
            }

            // AUTO-MIGRATION: Fix Mixed Content and Path issues for existing users
            const ollamaConfig = this.configMap.get("ollama")
            if (ollamaConfig) {
                if (ollamaConfig.baseUrl === "http://localhost:11434/v1" ||
                    ollamaConfig.baseUrl === "/api/ollama/v1" ||
                    ollamaConfig.baseUrl === "/api/ollama/v1/chat/completions" ||
                    ollamaConfig.baseUrl === "/api/chat") {
                    console.warn("Migrating Ollama config to use Secure Proxy (Native)...")
                    ollamaConfig.baseUrl = "/api/ollama/api/chat"
                    this.configMap.set("ollama", ollamaConfig)
                    this.saveSettings()
                }
                else if (ollamaConfig.baseUrl && ollamaConfig.baseUrl.includes("openrouter.ai")) {
                    console.warn("Correcting corrupted Ollama config...")
                    ollamaConfig.baseUrl = "/api/ollama/v1/chat/completions"
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

            // [ANTIGRAVITY] Fix 5: Cognitive Key Link
            // Ensure Gemini 3 inherits keys from Gemini Standard if missing
            const stdConfig = this.configMap.get("gemini")
            const v3Config = this.configMap.get("gemini-3") || {}

            const stdHasKeys = stdConfig && (stdConfig.apiKey || (stdConfig.keyLibrary && stdConfig.keyLibrary.length > 0))
            const v3HasKeys = v3Config.apiKey || (v3Config.keyLibrary && v3Config.keyLibrary.length > 0)

            if (stdHasKeys && !v3HasKeys) {
                console.log("🧠 Odie Neural Link: Syncing keys from Standard to Cognitive brain...")
                v3Config.apiKey = stdConfig.apiKey
                v3Config.keyLibrary = stdConfig.keyLibrary ? [...stdConfig.keyLibrary] : []
                this.configMap.set("gemini-3", v3Config)
                this.saveSettings()
            }


            this.providers.forEach(p => {
                const cfg = this.configMap.get(p.id)
                if (cfg) {
                    p.configure(cfg)
                }
            })

            const currentActive = this.getActiveProvider()
            if (currentActive) {
                const cfg = this.configMap.get(currentActive.id)
                // Infinity Library Support: Check library, then legacy key
                const hasKey = cfg?.apiKey || (cfg?.keyLibrary && cfg.keyLibrary.length > 0)

                if (currentActive.requiresKey && !hasKey) {
                    console.warn(`Active provider '${currentActive.id}' missing key. Falling back to Ollama.`)
                    this.setActiveProvider("ollama")
                }
            } else {
                this.setActiveProvider("ollama")
            }

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
