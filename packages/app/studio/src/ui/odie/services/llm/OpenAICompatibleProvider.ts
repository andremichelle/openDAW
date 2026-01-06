import { ObservableValue, DefaultObservableValue } from "@opendaw/lib-std"
import { LLMProvider, Message, ProviderConfig, LLMTool } from "./LLMProvider"
import { checkModelTier } from "./ModelPolicy"
import { ollamaInspector, ModelCapabilities } from "./OllamaCapabilityService"

export class OpenAICompatibleProvider implements LLMProvider {
    readonly id: string
    readonly manifest: {
        name: string
        description: string
        icon?: string
        getKeyUrl?: string
        docsUrl?: string
    }
    readonly requiresKey: boolean
    readonly requiresUrl: boolean

    private config: ProviderConfig = {}

    // Cache for capabilities to avoid spamming /api/show
    private capabilityCache = new Map<string, ModelCapabilities>()

    constructor(
        id: string = "openai_compat",
        name: string = "OpenAI Compatible",
        defaultUrl: string = "",
        requiresKey: boolean = true,
        description: string = "Compatible with OpenRouter, Ollama, LM Studio, etc."
    ) {
        this.id = id
        this.manifest = {
            name,
            description
        }
        this.requiresKey = requiresKey

        // Specific manifest enhancements based on ID
        if (id === "ollama") {
            this.manifest.icon = "🦙"
            this.manifest.getKeyUrl = "" // No key needed
            this.manifest.docsUrl = "https://ollama.com/"
        } else if (id === "openai") {
            this.manifest.icon = "🧠"
            this.manifest.getKeyUrl = "https://platform.openai.com/api-keys"
        } else if (id === "openrouter") {
            this.manifest.icon = "🌐"
            this.manifest.getKeyUrl = "https://openrouter.ai/keys"
        }

        // If a default URL is provided, set it immediately in a temp config so it's ready
        if (defaultUrl) {
            this.config.baseUrl = defaultUrl
        }

        // Always allow URL editing
        this.requiresUrl = true
    }

    async validate(): Promise<{ ok: boolean, message: string }> {
        try {
            const models = await this.fetchModels()
            // Special check for Ollama / Local
            if (models.length === 0) {
                return { ok: false, message: "Connected, but no models found." }
            }
            return { ok: true, message: `Connected! Found: ${models.join(", ")}` }
        } catch (e: any) {
            return { ok: false, message: e.message || "Connection Failed" }
        }
    }

    configure(config: ProviderConfig) {
        this.config = config
    }

    streamChat(
        messages: Message[],
        _context?: any,
        tools?: LLMTool[],
        onFinal?: (msg: Message) => void
    ): ObservableValue<string> {
        const url = this.config.baseUrl || ""
        const key = this.config.apiKey || ""
        // Default model logic (Delayed until run for auto-detection)
        let model = this.config.modelId

        const responseText = new DefaultObservableValue<string>("[0/3] Initializing...")

        // Check for common misconfigurations
        if (!key && !url.includes("localhost") && !url.includes("127.0.0.1") && !url.startsWith("/")) {
            responseText.setValue("⚠️ API Key required for this endpoint.")
            return responseText
        }

        const run = async (): Promise<void> => {
            let targetUrl = url

            // Critical Fix: Ensure we hit the Chat API, not the root
            if (this.id === "ollama" && !targetUrl.includes("/api/chat") && !targetUrl.includes("/api/generate")) {
                let root = targetUrl
                if (root.endsWith("/")) root = root.slice(0, -1)
                if (root.endsWith("/v1")) root = root.slice(0, -3)
                targetUrl = `${root}/api/chat`
            }

            this.debugLog = `[${new Date().toISOString()}] Starting Chat Stream...\nURL: ${targetUrl} (Original: ${url})\nModel: ${model}\n`

            try {

                // Auto-detect model if missing (Crucial for first run)
                if (!model && this.id === "ollama") {
                    this.debugLog += `[Auto-Detect] No model configured. Scanning...\n`
                    try {
                        const models = await this.fetchModels()
                        if (models.length > 0) {
                            model = models[0]
                            this.debugLog += `[Auto-Detect] Success. Using: ${model}\n`
                            this.config.modelId = model
                        } else {
                            this.debugLog += `[Auto-Detect] Failed. No models found.\n`
                        }
                    } catch (e: any) {
                        this.debugLog += `[Auto-Detect] Error: ${e.message}\n`
                    }

                    if (!model) {
                        this.debugLog += `[Fatal] No models found on server. Cannot proceed.\n`
                        responseText.setValue("⚠️ Connected to Ollama, but no models found. Please run 'ollama pull llama3' or check your installed models.")
                        return
                    }
                }

                // --- CAPABILITY INSPECTION ---
                let capabilities: ModelCapabilities | null = null

                if (this.id === "ollama") {
                    // Check cache first
                    if (this.capabilityCache.has(model || "")) {
                        capabilities = this.capabilityCache.get(model || "")!
                    } else {
                        this.debugLog += `[Inspect] Analyzing physics for ${model}...\n`
                        capabilities = await ollamaInspector.inspect(targetUrl, model || "")
                        if (capabilities) {
                            this.capabilityCache.set(model || "", capabilities)
                            this.debugLog += `[Inspect] Result: ${capabilities.parameterSize} / ${capabilities.quantization} -> ${capabilities.suggestedTier}\n`
                        } else {
                            this.debugLog += `[Inspect] Failed to inspect. Falling back to name check.\n`
                        }
                    }
                }

                // --- WHITELIST ENFORCEMENT ---
                let activeTools = tools
                if (activeTools && activeTools.length > 0) {
                    const policy = checkModelTier(model || "unknown")
                    if (!policy.allowTools) {
                        console.warn(`[Policy] Model ${model} is Tier 3. Tools disabled.`)
                        this.debugLog += `[Policy] Tools disabled for Tier 3 model (${model}).\n`
                        activeTools = undefined
                    } else {
                        // Log Override usage if active
                        if (this.config.forceAgentMode) {
                            this.debugLog += `[Policy] ⚡ MANUAL OVERRIDE ACTIVE. Tools enabled.\n`
                        }
                        this.debugLog += `[Policy] Tools enabled for Agent model (${model}).\n`
                    }
                }

                const controller = new AbortController()
                const timeoutId = setTimeout(() => controller.abort(), 60000) // 60s Timeout (Better for tools/local)

                this.debugLog += `Fetching...\n`

                // Construct Request Body
                const body: any = {
                    model: model,
                    messages: messages.map(m => ({
                        role: m.role === "model" ? "assistant" : (m.role === "system" ? "system" : "user"),
                        content: m.content
                    })),
                    stream: true
                }

                // Inject Tools if Allowed
                if (activeTools && activeTools.length > 0) {
                    body.tools = activeTools.map(t => ({
                        type: "function",
                        function: {
                            name: t.name,
                            description: t.description,
                            parameters: t.parameters
                        }
                    }))
                    // For Ollama/OpenAI, "auto" is default, but explicit is safer
                    // Only sent if tools exist
                }

                const response = await fetch(targetUrl, {
                    method: "POST",
                    signal: controller.signal,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${key}`,
                        "HTTP-Referer": "https://opendaw.studio",
                        "X-Title": "OpenDAW"
                    },
                    body: JSON.stringify(body)
                })
                clearTimeout(timeoutId)

                if (!response.ok) {
                    const err = await response.text()
                    this.debugLog += `Error Body: ${err}\n`
                    responseText.setValue(this.formatError(response.status, err))
                    return
                }

                if (!response.body) throw new Error("No response body")

                const reader = response.body.getReader()
                const decoder = new TextDecoder("utf-8")
                let accumulatedText = ""
                let toolCallsBuff: any[] = [] // Accumulate tool call fragments
                let buffer = ""

                while (true) {
                    const { done, value } = await reader.read()
                    if (value) {
                        const chunk = decoder.decode(value, { stream: true })
                        buffer += chunk
                    }

                    if (done) break

                    const lines = buffer.split("\n")
                    let tail = lines.pop() || ""

                    // JSON Blob Heuristics (Ollama Native)
                    if (tail && tail.trim().startsWith("{") && tail.trim().endsWith("}")) {
                        try { JSON.parse(tail); lines.push(tail); tail = ""; } catch (e) { }
                    }
                    buffer = tail

                    for (const line of lines) {
                        const trimmed = line.trim()
                        if (!trimmed) continue

                        let jsonStr = trimmed
                        if (trimmed.startsWith("data: ")) jsonStr = trimmed.substring(6)
                        if (jsonStr === "[DONE]") break

                        try {
                            // DEBUG: Log Raw Stream Chunk to catch malformed JSON from Local Models
                            // console.log("[Stream Raw]", jsonStr) 
                            const parsed = JSON.parse(jsonStr)

                            // 1. OpenAI / Ollama (Chat Endpoint)
                            const choice = parsed.choices?.[0]
                            const delta = choice?.delta

                            // Content
                            if (delta?.content) {
                                accumulatedText += delta.content
                                responseText.setValue(accumulatedText)
                            }

                            // Tool Calls (Streamed fragments)
                            if (delta?.tool_calls) {
                                console.log("[Stream] Tool Call Delta:", JSON.stringify(delta.tool_calls))
                                delta.tool_calls.forEach((tc: any) => {
                                    const idx = tc.index
                                    if (!toolCallsBuff[idx]) toolCallsBuff[idx] = { id: "", name: "", arguments: "" }

                                    if (tc.id) toolCallsBuff[idx].id += tc.id
                                    if (tc.function?.name) toolCallsBuff[idx].name += tc.function.name
                                    if (tc.function?.arguments) toolCallsBuff[idx].arguments += tc.function.arguments
                                })
                            }

                            // Ollama Native (Generate Endpoint - unlikely used here but kept for compat)
                            const ollamaResponse = parsed.response // /api/generate
                            if (ollamaResponse) {
                                accumulatedText += ollamaResponse
                                responseText.setValue(accumulatedText)
                            }
                            const ollamaMessage = parsed.message // /api/chat (Non-streaming fallback)
                            if (ollamaMessage?.content) {
                                accumulatedText += ollamaMessage.content
                                responseText.setValue(accumulatedText)
                            }
                            // Ollama Tool Calls (Non-streaming / final block)
                            if (ollamaMessage?.tool_calls) {
                                console.log("[Ollama] Raw Tool Calls:", ollamaMessage.tool_calls)
                                toolCallsBuff = ollamaMessage.tool_calls.map((tc: any) => ({
                                    id: "call_" + Math.random().toString(36).substr(2, 9),
                                    name: tc.function.name,
                                    arguments: JSON.stringify(tc.function.arguments) // Standardize to string for parsing later
                                }))
                            }

                        } catch (e) {
                            // JSON parse error (skip line)
                            // Only log if it's not a common "data: [DONE]" fragment
                            if (!jsonStr.includes("[DONE]")) {
                                console.warn("[Stream Parse Error]", e, jsonStr)
                            }
                        }
                    }
                }

                // FINALIZATION

                // Process Tool Calls
                const finalToolCalls = toolCallsBuff.map(tc => {
                    try {
                        return {
                            id: tc.id || "call_unknown",
                            name: tc.name,
                            arguments: JSON.parse(tc.arguments || "{}")
                        }
                    } catch (e) {
                        console.error("Failed to parse tool arguments", e)
                        return null
                    }
                }).filter(t => t !== null) as any[]

                this.debugLog += `[Done] Final Text: ${accumulatedText.length}, ToolCalls: ${finalToolCalls.length}\n`

                // Allow empty text IF there are tool calls
                if (!accumulatedText && finalToolCalls.length === 0) {
                    this.debugLog += `[WARN] No content extracted!\n`
                    responseText.setValue("⚠️ Connected, but received no text content.")
                    return
                }

                // Fire Final Callback
                if (onFinal) {
                    onFinal({
                        id: "final_" + Date.now(),
                        role: "model",
                        content: accumulatedText,
                        tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
                        timestamp: Date.now()
                    })
                }

            } catch (e: any) {
                this.debugLog += `[Fatal] ${e.message}\n`
                console.error(e)
                responseText.setValue(`Error: ${e.message}`)
            }
        }

        this.runStream(async () => { await run() }).catch(e => {
            console.error("Critical Stream Failure", e)
            responseText.setValue(`Critical Error: ${e.message}`)
        })
        return responseText
    }

    // Captured debug info for the UI
    public debugLog: string = ""

    async fetchModels(): Promise<string[]> {
        const baseUrl = this.config.baseUrl || ""
        const key = this.config.apiKey || ""
        if (!baseUrl) return []

        const headers: any = {}
        if (key) headers["Authorization"] = `Bearer ${key}`

        let log = `--- Connection Diagnostics ---\nTimestamp: ${new Date().toISOString()}\nBaseURL: ${baseUrl}\n`

        const foundModels: Set<string> = new Set()

        // Strategy 1: OpenAI Standard (/v1/models)
        try {
            // Adjust URL: If it ends in /chat/completions, strip it to find root
            let cleanUrl = baseUrl.replace("/chat/completions", "")
            if (cleanUrl.endsWith("/v1")) cleanUrl = cleanUrl
            else if (!cleanUrl.endsWith("/v1")) cleanUrl = cleanUrl.endsWith("/") ? `${cleanUrl}v1` : `${cleanUrl}/v1`

            const targetUrl = `${cleanUrl}/models`
            log += `\n[Strategy 1] GET ${targetUrl}`

            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 10000)

            try {
                const res = await fetch(targetUrl, { headers, signal: controller.signal })
                clearTimeout(timeout)
                log += `\nStatus: ${res.status} ${res.statusText}`

                if (res.ok) {
                    const text = await res.text()
                    try {
                        const data = JSON.parse(text)
                        log += `\nBody: ${JSON.stringify(data, null, 2).slice(0, 500)}...`

                        if (Array.isArray(data.data)) {
                            // OpenAI Standard
                            data.data.forEach((m: any) => foundModels.add(m.id))
                        }
                        // Ollama sometimes leaks 'models' here too
                        if (Array.isArray(data.models)) {
                            data.models.forEach((m: any) => foundModels.add(m.name || m.id))
                        }
                    } catch (e) {
                        log += `\nParse Error: ${text.slice(0, 200)}`
                    }
                }
            } catch (e: any) {
                log += `\nError: ${e.message}`
            }

            // Strategy 2: Ollama Standard (/api/tags)
            // Ollama usually runs on port 11434, root is often just http://localhost:11434
            // If user passed .../v1 or .../api/chat, strip it.
            const rootUrl = baseUrl
                .replace("/v1/chat/completions", "")
                .replace("/api/chat", "")
                .replace(/\/v1\/?$/, "")
            const targetUrl2 = `${rootUrl}/api/tags`
            log += `\n\n[Strategy 2] GET ${targetUrl2}`

            const controller2 = new AbortController()
            const timeout2 = setTimeout(() => controller2.abort(), 10000)

            try {
                const res = await fetch(targetUrl2, { signal: controller2.signal })
                clearTimeout(timeout2)
                log += `\nStatus: ${res.status} ${res.statusText}`

                if (res.ok) {
                    const text = await res.text()
                    try {
                        const data = JSON.parse(text)
                        log += `\nBody: ${JSON.stringify(data, null, 2).slice(0, 500)}...`

                        if (Array.isArray(data.models)) {
                            data.models.forEach((m: any) => foundModels.add(m.name))
                        }
                    } catch (err) {
                        log += `\nParse Error: ${text.slice(0, 200)}`
                    }
                }
            } catch (e: any) {
                log += `\nError: ${e.message}`
            }

        } catch (e: any) {
            log += `\nOuter Error: ${e.message}`
        }

        log += `\n\nTotal Models Found: ${foundModels.size}`
        this.debugLog = log
        console.log(this.debugLog)

        return Array.from(foundModels)
    }

    private async runStream(runner: () => Promise<void>) {
        await runner()
    }

    /**
     * Convert API errors into friendly, helpful messages
     */
    private formatError(status: number, rawText: string): string {
        try {
            // Robust Parsing: Handle non-JSON responses gracefully
            let errorObj: any = {}
            if (rawText.trim().startsWith("{")) {
                try {
                    const parsed = JSON.parse(rawText)
                    errorObj = parsed.error || parsed
                } catch (e) {
                    // Partial JSON? Use raw
                    errorObj = { message: rawText }
                }
            } else {
                errorObj = { message: rawText }
            }

            const message = errorObj?.message || ''

            // Rate Limit
            if (status === 429 || message.toLowerCase().includes('rate')) {
                return `⏳ **Too Many Requests**\n\nSlow down a bit! Wait a moment and try again.`
            }

            // Auth Issues
            if (status === 401 || status === 403) {
                return `🔑 **Access Denied**\n\nCheck your API key in Settings.`
            }

            // Not Found (Model or Endpoint)
            if (status === 404) {
                return "```json\n" + JSON.stringify({
                    ui_component: "error_card",
                    data: {
                        title: "Model Not Found",
                        message: "We couldn't connect to the configured AI model. Please check that Ollama is running and the model is installed.",
                        actions: [
                            { label: "⚙️ Open Settings", id: "open_settings" }
                        ]
                    }
                }, null, 2) + "\n```"
            }

            // Server Errors
            if (status >= 500) {
                return `🔧 **Server Issue**\n\nThe AI service is having problems. Try again in a minute.`
            }

            // Generic with parsed message
            if (message) {
                // Formatting: Capitalize first letter
                const formatted = message.charAt(0).toUpperCase() + message.slice(1)
                return `⚠️ **Error ${status}**: ${formatted}`
            }
        } catch (e) {
            // JSON parsing failed completely
            return `⚠️ **Error (${status})**\n\nServer returned invalid response.`
        }

        return `⚠️ **Error (${status})**\n\nSomething went wrong. Please try again.`
    }
}
