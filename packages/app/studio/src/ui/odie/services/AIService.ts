import { DefaultObservableValue, ObservableValue } from "@opendaw/lib-std"
import { LLMProvider, Message, ProviderConfig } from "./llm/LLMProvider"
import { Gemini3Provider } from "./llm/Gemini3Provider"
import { OpenAICompatibleProvider } from "./llm/OpenAICompatibleProvider"
import { ContextService } from "./ContextService"
import { ODIE_MOLECULAR_KNOWLEDGE } from "../data/OdieKnowledgeBase"

const STORAGE_KEY_CONFIGS = "odie_provider_configs"
const STORAGE_KEY_ACTIVE = "odie_provider_active"

export class AIService {
    readonly providers: LLMProvider[] = []
    readonly activeProviderId = new DefaultObservableValue<string>("gemini-3")
    readonly wizardCompleted = new DefaultObservableValue<boolean>(false)

    readonly contextService = new ContextService()
    private configMap = new Map<string, any>()

    constructor() {
        // Register Providers
        this.providers.push(new Gemini3Provider())

        const ollama = new OpenAICompatibleProvider(
            "ollama",
            "Ollama (Local)",
            "/api/ollama",
            false
        )

        ollama.onConfigChange = (newConfig) => {
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

    resetWizard() {
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
        this.configMap.set(providerId, config)
        this.saveSettings()
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

    streamChat(messages: Message[], context?: any, tools?: any[], onFinal?: (msg: Message) => void, onStatusChange?: (status: string, model?: string) => void): ObservableValue<{ content: string; thoughts?: string }> {
        const provider = this.getActiveProvider()

        if (!provider) {
            return new DefaultObservableValue({ content: "Error: No AI Provider selected." })
        }

        const config = this.getConfig(provider.id)
        provider.configure(config)

        // DAW Context injection
        const dawContext = this.contextService.scan(config.modelId, config.forceAgentMode)

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

[KNOWLEDGE BASE]
${ODIE_MOLECULAR_KNOWLEDGE}
`

        const modifiedMessages = [...messages]
        const systemIndex = modifiedMessages.findIndex(m => m.role === 'system')

        if (systemIndex >= 0) {
            modifiedMessages[systemIndex] = {
                ...modifiedMessages[systemIndex],
                content: modifiedMessages[systemIndex].content + "\n" + contextPrompt
            }
        } else {
            modifiedMessages.unshift({
                role: 'system',
                content: `You are Odie, an AI Assistant in OpenDAW.\n${contextPrompt}`,
                id: "system-init",
                timestamp: Date.now()
            })
        }

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
                Object.keys(json).forEach(key => {
                    this.configMap.set(key, json[key])
                })
            }

            const active = localStorage.getItem(STORAGE_KEY_ACTIVE)
            if (active && this.providers.find(p => p.id === active)) {
                this.activeProviderId.setValue(active)
            } else {
                this.activeProviderId.setValue("gemini")
            }

            // Migration logic
            const ollamaConfig = this.configMap.get("ollama")
            if (ollamaConfig) {
                // FORCE PROXY if using default or direct localhost (CORS bypass)
                if (!ollamaConfig.baseUrl ||
                    ollamaConfig.baseUrl.trim() === "" ||
                    ollamaConfig.baseUrl.includes("localhost:11434") ||
                    ollamaConfig.baseUrl.includes("127.0.0.1:11434")) {
                    ollamaConfig.baseUrl = "/api/ollama"
                    this.configMap.set("ollama", ollamaConfig)
                    this.saveSettings()
                }

                if (ollamaConfig.baseUrl && ollamaConfig.baseUrl.includes("openrouter.ai")) {
                    ollamaConfig.baseUrl = "https://openrouter.ai/api/v1/chat/completions"
                    this.configMap.set("ollama", ollamaConfig)
                    this.saveSettings()
                }
            }

            if (this.configMap.has("ollama")) {
                const ollamaConfig = this.configMap.get("ollama")!
                if (ollamaConfig.modelId === "llama3") {
                    ollamaConfig.modelId = ""
                    this.configMap.set("ollama", ollamaConfig)
                    this.saveSettings()
                }
            } else {
                this.configMap.set("ollama", { baseUrl: "/api/ollama", modelId: "" })
                this.saveSettings()
            }

            this.providers.forEach(p => {
                const cfg = this.configMap.get(p.id)
                if (cfg) p.configure(cfg)
            })

        } catch (e) {
            console.error("Odie: Failed to load settings", e)
        }
    }

    private saveSettings() {
        const obj: any = {}
        this.configMap.forEach((v, k) => obj[k] = v)
        localStorage.setItem(STORAGE_KEY_CONFIGS, JSON.stringify(obj))
    }
}
