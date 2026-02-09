import { ObservableValue, DefaultObservableValue } from "@opendaw/lib-std"
import { LLMProvider, Message, ProviderConfig, LLMTool, ToolCall } from "./LLMProvider"
import { checkModelTier } from "./ModelPolicy"
import { ollamaInspector } from "./OllamaCapabilityService"

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

    // Callback for persistence
    public onConfigChange?: (newConfig: ProviderConfig) => void

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

    async checkHardwareFit(): Promise<{ ok: boolean, message: string, data?: any }> {
        if (this.id !== "ollama") return { ok: true, message: "Hardware fitting for cloud providers is handled automatically." }

        try {
            const baseUrl = this.config.baseUrl || ""
            let modelId = this.config.modelId

            // Auto-detect model if missing
            if (!modelId) {
                const available = await this.fetchModels()
                if (available.length > 0) {
                    modelId = available[0]
                    this.config.modelId = modelId
                }
            }

            if (!modelId) {
                return { ok: false, message: "No model configured or found. Please select a model first." }
            }

            let models = await ollamaInspector.getHardwareStatus(baseUrl)

            // If no model is active, trigger a warm-up
            if (models.length === 0 || !models.find(m => m.name === modelId)) {
                await this.warmUpModel(baseUrl, modelId)
                // Re-fetch
                models = await ollamaInspector.getHardwareStatus(baseUrl)
            }

            if (models.length === 0) {
                return {
                    ok: false,
                    message: "Failed to load model into memory. Check your Ollama logs."
                }
            }

            // Find the most relevant model (or current one)
            const target = models.find(m => m.name === modelId) || models[0]

            const size = target.size || 0
            const vram = target.size_vram || 0

            let gpuPercent = 0
            if (size > 0) gpuPercent = Math.round((vram / size) * 100)
            const cpuPercent = 100 - gpuPercent

            if (gpuPercent === 100) {
                return {
                    ok: true,
                    message: `Elite Fit: ${target.name} is running 100% on your GPU. Your audio engines are safe.`,
                    data: { gpu: gpuPercent, cpu: cpuPercent, model: target.name }
                }
            } else if (gpuPercent > 0) {
                return {
                    ok: false,
                    message: `Partial Spillover: ${target.name} is using ${cpuPercent}% CPU muscles. This may interfere with heavy audio sessions.`,
                    data: { gpu: gpuPercent, cpu: cpuPercent, model: target.name }
                }
            } else {
                return {
                    ok: false,
                    message: `Critical CPU Load: ${target.name} is running 100% on your CPU. This is highly likely to cause audio glitches.`,
                    data: { gpu: gpuPercent, cpu: cpuPercent, model: target.name }
                }
            }

        } catch (e: any) {
            return { ok: false, message: `Check Failed: ${e.message}` }
        }
    }

    private async warmUpModel(baseUrl: string, modelId: string) {
        let root = baseUrl
        if (root.includes("/v1")) root = root.replace(/\/v1\/?$/, "")
        if (root.includes("/api/chat")) root = root.replace(/\/api\/chat$/, "")
        if (root.endsWith("/")) root = root.slice(0, -1)

        const url = `${root}/api/generate`

        try {
            // We use a no-op prompt to just force a load
            await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: modelId,
                    prompt: "",
                    stream: false
                })
            })
        } catch (e) {
            console.error("🔍 Model Warm-up Failed", e)
        }
    }

    async validate(): Promise<{ ok: boolean, message: string }> {
        try {
            const models = await this.fetchModels()
            // Special check for Ollama / Local
            if (models.length === 0) {
                // Check if we hit a CORS error (Browser enforcement)
                if (this.debugLog.includes("Failed to fetch") || this.debugLog.includes("NetworkError")) {
                    return {
                        ok: false,
                        message: "Network Error. If using Ollama, ensure `OLLAMA_ORIGINS=\"*\"` is set in your environment variables."
                    }
                }
                return { ok: false, message: "Connected, but no models found." }
            }
            return { ok: true, message: `Connected! Found: ${models.join(", ")}` }
        } catch (e: any) {
            return { ok: false, message: e.message || "Connection Failed" }
        }
    }

    configure(config: ProviderConfig) {
        // Clean up baseUrl to ensure it's a root or appropriate endpoint
        if (config.baseUrl && this.id === "ollama") {
            let clean = config.baseUrl.trim()
            if (clean.endsWith("/api/chat")) clean = clean.replace(/\/api\/chat\/?$/, "")
            if (clean.endsWith("/api/generate")) clean = clean.replace(/\/api\/generate\/?$/, "")
            if (clean.endsWith("/v1")) clean = clean.replace(/\/v1\/?$/, "")
            if (clean.endsWith("/")) clean = clean.slice(0, -1)
            config.baseUrl = clean
        }
        this.config = config
    }

    streamChat(
        messages: Message[],
        _context?: unknown,
        tools?: LLMTool[],
        onFinal?: (msg: Message) => void,
        _onStatusChange?: (status: string, model?: string) => void
    ): ObservableValue<{ content: string; thoughts?: string }> {
        const url = this.config.baseUrl || ""
        const key = this.config.apiKey || ""
        let model = this.config.modelId

        const responseText = new DefaultObservableValue<{ content: string; thoughts?: string }>({ content: "[0/3] Initializing..." })

        if (!key && !url.includes("localhost") && !url.includes("127.0.0.1") && !url.startsWith("/")) {
            responseText.setValue({ content: "⚠️ API Key required for this endpoint." })
            return responseText
        }

        const run = async (): Promise<void> => {
            this.debugLog = `[${new Date().toISOString()}] Starting Chat Stream...\n`
            let activeTools = tools
            let targetUrl = ""
            let accumulatedThinking = ""
            let accumulatedText = ""
            let isThinking = false
            let toolCallsBuff: any[] = []

            try {
                if (!model && this.id === "ollama") {
                    this.debugLog += `[Auto-Detect] No model configured. Scanning...\n`
                    try {
                        const models = await this.fetchModels()
                        if (models.length > 0) {
                            model = models[0]
                            this.debugLog += `[Auto-Detect] Success. Using: ${model}\n`
                            this.config.modelId = model
                            if (this.onConfigChange) this.onConfigChange({ ...this.config })
                        }
                    } catch (e: any) {
                        this.debugLog += `[Auto-Detect] Error: ${e.message}\n`
                    }

                    if (!model) {
                        responseText.setValue({ content: "⚠️ Connected to Ollama, but no models found.\n👉 Please run: `ollama pull qwen2.5-coder`" })
                        return
                    }
                }

                let workingUrl = this.config.baseUrl || ""
                targetUrl = workingUrl

                if (this.id === "ollama" && !targetUrl.includes("/api/chat") && !targetUrl.includes("/api/generate")) {
                    let root = targetUrl
                    if (root.endsWith("/")) root = root.slice(0, -1)
                    if (root.endsWith("/v1")) root = root.slice(0, -3)
                    targetUrl = `${root}/api/chat`
                }

                this.debugLog += `URL: ${targetUrl}\nModel: ${model}\n`

                // --- CAPABILITY INSPECTION ---
                // Removed as per diff, assuming it's no longer needed or handled elsewhere.
                // If it was intended to be kept, this would be a deviation from the provided diff.

                // --- WHITELIST ENFORCEMENT ---
                if (activeTools && activeTools.length > 0) {
                    const policy = checkModelTier()
                    if (!policy.allowTools && !this.config.forceAgentMode) {
                        this.debugLog += `[Policy] Tools disabled for Tier 3 model (${model}).\n`
                        activeTools = undefined
                    } else {
                        this.debugLog += `[Policy] Tools enabled for Agent model (${model}).\n`
                    }
                }

                const controller = new AbortController()
                const timeoutId = setTimeout(() => controller.abort(), 60000)

                this.debugLog += `Fetching...\n`

                const body: any = {
                    model: model,
                    messages: messages.map(m => {
                        let role = "user"
                        if (m.role === "model") role = "assistant"
                        else if (m.role === "system") role = "system"
                        else if (m.role === "function") role = "function"
                        else if (m.role !== "user") {
                            // Default fallback/warning for safety
                            console.warn("Unknown role:", m.role)
                            role = "user"
                        }

                        const msg: any = { role, content: m.content }
                        if (m.name) msg.name = m.name
                        if (m.tool_calls) msg.tool_calls = m.tool_calls
                        return msg
                    }),
                    stream: true
                }

                if (activeTools && activeTools.length > 0) {
                    body.tools = activeTools.map(t => ({
                        type: "function",
                        function: {
                            name: t.name,
                            description: t.description,
                            parameters: t.parameters
                        }
                    }))
                }

                const response = await fetch(targetUrl, {
                    method: "POST",
                    signal: controller.signal,
                    headers: {
                        "Content-Type": "application/json",
                        "HTTP-Referer": "https://opendaw.studio",
                        "X-Title": "OpenDAW",
                        ...(key ? { "Authorization": `Bearer ${key}` } : {})
                    },
                    body: JSON.stringify(body)
                })
                clearTimeout(timeoutId)

                if (!response.ok) {
                    const err = await response.text()
                    this.debugLog += `Error Body: ${err}\n`
                    responseText.setValue({ content: this.formatError(response.status, err) })
                    return
                }

                if (!response.body) throw new Error("No response body")

                const reader = response.body.getReader()
                const decoder = new TextDecoder("utf-8")
                let buffer = ""

                while (true) {
                    const { done, value } = await reader.read()
                    if (value) {
                        buffer += decoder.decode(value, { stream: true })
                    }

                    const lines = buffer.split("\n")
                    buffer = lines.pop() || ""

                    for (const line of lines) {
                        const trimmed = line.trim()
                        if (!trimmed) continue
                        let jsonStr = trimmed
                        if (trimmed.startsWith("data: ")) jsonStr = trimmed.substring(6)
                        if (jsonStr === "[DONE]") break

                        try {
                            const parsed = JSON.parse(jsonStr)
                            const ollamaMessage = parsed.message
                            const choice = parsed.choices?.[0]
                            const delta = choice?.delta

                            let chunk = delta?.content || parsed.message?.content || parsed.response || ""
                            let thinkingChunk = delta?.thinking || delta?.reasoning_content || parsed.message?.thinking || ""

                            if (chunk) {
                                if (chunk.includes("<think>")) {
                                    const parts = chunk.split("<think>")
                                    accumulatedText += parts[0]
                                    isThinking = true
                                    chunk = parts[1] || ""
                                }

                                if (chunk.includes("</think>")) {
                                    const parts = chunk.split("</think>")
                                    accumulatedThinking += parts[0]
                                    isThinking = false
                                    chunk = parts[1] || ""
                                }

                                if (isThinking) {
                                    accumulatedThinking += chunk
                                } else {
                                    accumulatedText += chunk
                                }
                            }

                            if (thinkingChunk) accumulatedThinking += thinkingChunk

                            responseText.setValue({
                                content: accumulatedText,
                                thoughts: accumulatedThinking
                            })

                            if (ollamaMessage?.tool_calls) {
                                toolCallsBuff.push(...ollamaMessage.tool_calls.map((tc: any) => ({
                                    id: "call_" + Math.random().toString(36).substr(2, 9),
                                    name: tc.function.name,
                                    arguments: JSON.stringify(tc.function.arguments)
                                })))
                            }
                            if (delta?.tool_calls) {
                                delta.tool_calls.forEach((tc: any) => {
                                    // Use index if available (OpenAI standard), fallback to strict ID matching, fallback to last item
                                    const index = tc.index;

                                    // 1. Try to find existing call by index
                                    if (typeof index === 'number') {
                                        if (!toolCallsBuff[index]) {
                                            toolCallsBuff[index] = {
                                                id: tc.id || ("call_" + Math.random().toString(36).substr(2, 9)),
                                                name: tc.function?.name || "",
                                                arguments: tc.function?.arguments || ""
                                            }
                                        } else {
                                            if (tc.function?.arguments) toolCallsBuff[index].arguments += tc.function.arguments;
                                            if (tc.function?.name) toolCallsBuff[index].name += tc.function.name; // Rare but possible
                                        }
                                        return;
                                    }

                                    // 2. Fallback logic (for non-compliant servers): find by ID or append to last
                                    let details = toolCallsBuff.find(t => t.id === tc.id);
                                    if (!details && toolCallsBuff.length > 0) {
                                        // Assume it belongs to the last one if no index/id provided (Ollama sometimes does this)
                                        details = toolCallsBuff[toolCallsBuff.length - 1];
                                    }

                                    if (details && !tc.id && !tc.function?.name) {
                                        // Just argument delta
                                        if (tc.function?.arguments) details.arguments += tc.function.arguments;
                                    } else {
                                        // New call potentially
                                        if (tc.function) {
                                            toolCallsBuff.push({
                                                id: tc.id || ("call_" + Math.random().toString(36).substr(2, 9)),
                                                name: tc.function.name,
                                                arguments: tc.function.arguments
                                            })
                                        }
                                    }
                                })
                            }
                        } catch (e) {
                            if (!jsonStr.includes("[DONE]")) console.warn("[Stream Parse Error]", e, jsonStr)
                        }
                    }
                    if (done) break
                }

                this.debugLog += `[Done] Final Text: ${accumulatedText.length}, ToolCalls: ${toolCallsBuff.length}\n`

                const finalToolCalls = toolCallsBuff.map(tc => {
                    try {
                        return {
                            id: tc.id || "call_unknown",
                            name: tc.name,
                            arguments: typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments
                        }
                    } catch (e) {
                        console.error("Failed to parse tool arguments", e)
                        return null
                    }
                }).filter(t => t !== null) as ToolCall[]

                if (!accumulatedText && finalToolCalls.length === 0) {
                    this.debugLog += `[WARN] No content extracted!\n`
                    responseText.setValue({ content: "⚠️ Connected, but received no text content." })
                }

                if (onFinal) {
                    onFinal({
                        id: "final_" + Date.now(),
                        role: "model",
                        content: accumulatedText,
                        thoughts: accumulatedThinking,
                        tool_calls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
                        timestamp: Date.now()
                    })
                }
            } catch (e: any) {
                this.debugLog += `[Fatal] ${e.message}\n`
                console.error(e)

                if (e.name === "AbortError") {
                    responseText.setValue({ content: "⚠️ Request timed out." })
                } else {
                    const isCORSorNetworkError = e instanceof TypeError || e.message === "Failed to fetch" || e.message.includes("NetworkError")

                    if (isCORSorNetworkError && (targetUrl.includes("localhost") || targetUrl.includes("127.0.0.1"))) {
                        responseText.setValue({
                            content: `🚫 **Connection Blocked (CORS)**\n\n` +
                                `The browser blocked the request to Ollama at \`${targetUrl}\`.\n\n` +
                                `**To fix**, run Ollama with:\n` +
                                `\`\`\`bash\nOLLAMA_ORIGINS="*" ollama serve\n\`\`\`\n` +
                                `_Or use the '/api/ollama' proxy if available._`
                        })
                    } else {
                        responseText.setValue({ content: `Error: ${e.message}` })
                    }
                }
            }
        }

        run().catch(err => {
            console.error("[OpenAICompatibleProvider] Stream Error:", err)
            responseText.setValue({ content: "**System Error**: Failed to initialize stream." })
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
            if (!cleanUrl.endsWith("/v1")) {
                cleanUrl = cleanUrl.endsWith("/") ? `${cleanUrl}v1` : `${cleanUrl}/v1`
            }

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
                .replace(/\/v1\/chat\/completions\/?$/, "")
                .replace(/\/api\/chat\/?$/, "")
                .replace(/\/v1\/?$/, "")
            const targetUrl2 = `${rootUrl}/api/tags`
            log += `\n\n[Strategy 2] GET ${targetUrl2}`

            const controller2 = new AbortController()
            const timeout2 = setTimeout(() => controller2.abort(), 10000)

            try {
                // Optimization: If we are on HTTPS, direct fetch to HTTP localhost will ALWAYS fail CORS/Mixed Content.
                // In this case, Strategy 2 is a waste of time. Skip and let Strategy 3 (Proxy) handle it.
                if (location.protocol === "https:" && targetUrl2.startsWith("http://")) {
                    log += `\nSkipping Strategy 2 (Direct HTTP to HTTPS origin will fail).`
                } else {
                    const res = await fetch(targetUrl2, { signal: controller2.signal })
                    clearTimeout(timeout2)
                    log += `\nStatus: ${res.status} ${res.statusText}`

                    if (res.ok) {
                        const text = await res.text()
                        try {
                            const data = JSON.parse(text)
                            log += `\nBody: ${JSON.stringify(data, null, 2).slice(0, 500)}...`

                            if (Array.isArray(data.models)) {
                                // Support 'name' (Ollama) and 'id' (Generic)
                                data.models.forEach((m: any) => foundModels.add(m.name || m.id || m.model))
                            }
                        } catch (err) {
                            log += `\nParse Error: ${text.slice(0, 200)}`
                        }
                    } else {
                        log += `\nResponse Not OK: ${res.status}`
                    }
                }
            } catch (e: any) {
                const isNetwork = e.message.includes("fetch") || e.name === "TypeError"
                const hint = isNetwork ? " (Check CORS/OLLAMA_ORIGINS)" : ""
                log += `\nError: ${e.message}${hint}`
            }

            // Strategy 3: Auto-Detect / Fallback (The "Magic" Fix)
            // If we haven't found models yet, and we are Ollama, try known standard endpoints regardless of config.
            if (foundModels.size === 0 && this.id === "ollama") {
                const fallbacks = [
                    "/api/ollama", // Proxy-First: Avoid CORS
                    "http://localhost:11434", // Direct: Fallback
                ]

                for (const fallbackBase of fallbacks) {
                    // Avoid re-testing the configured base if it matches
                    const cleanBase = baseUrl.replace(/\/api\/chat\/?$/, "").replace(/\/v1\/?$/, "")
                    if (fallbackBase === cleanBase) continue

                    const fallbackUrl = `${fallbackBase}/api/tags`
                    log += `\n\n[Strategy 3] Auto-Detect GET ${fallbackUrl}`

                    try {
                        const controller3 = new AbortController()
                        const timeout3 = setTimeout(() => controller3.abort(), 5000) // Increased to 5s to avoid flakiness
                        const res = await fetch(fallbackUrl, { signal: controller3.signal })
                        clearTimeout(timeout3)

                        log += `\nStatus: ${res.status}`
                        if (res.ok) {
                            const text = await res.text()
                            const data = JSON.parse(text)
                            if (Array.isArray(data.models)) {
                                data.models.forEach((m: any) => foundModels.add(m.name || m.id || m.model))
                                if (foundModels.size > 0) {
                                    log += `\n🎯 Auto-Detect Success! Switching baseUrl to: ${fallbackBase}`
                                    // AUTO-HEAL: Update the instance URL so chat works
                                    // Note: This overrides the user's bad config for this session.
                                    this.config.baseUrl = fallbackBase
                                    // AUTO-HEAL: Persist the working URL
                                    if (this.onConfigChange) this.onConfigChange({ ...this.config })
                                    break // Stop trying fallbacks

                                }
                            }
                        }
                    } catch (e: any) {
                        log += `\nFallback Error: ${e.message}`
                    }
                }

                // If we found models via Strategy 3, clear the previous errors in debug log
                // so that validate() returns a success status.
                if (foundModels.size > 0 && log.includes("Error:")) {
                    log = log.replace(/\[Strategy 1\][\s\S]*?\[Strategy 3\]/, "[Strategy 1 & 2 Failed (CORS/Network), but Strategy 3 Saved the Day]\n\n[Strategy 3]")
                }
            }

        } catch (e: any) {
            log += `\nOuter Error: ${e.message}`
        }

        log += `\n\nTotal Models Found: ${foundModels.size}`
        this.debugLog = log
        // console.log(this.debugLog)

        return Array.from(foundModels)
    }

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
