import { ObservableValue, DefaultObservableValue, Nullable, isAbsent, isDefined } from "@opendaw/lib-std"
import { LLMProvider, Message, ProviderConfig, LLMTool } from "./LLMProvider"

type GeminiPart =
    | { text: string; thought?: boolean }
    | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
    | { functionResponse: { name: string; response: Record<string, unknown> } }
    | { inlineData: { mimeType: string; data: string } }

type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] }
type GeminiTool = { functionDeclarations: unknown[] }
type GeminiRequest = {
    contents: GeminiContent[];
    system_instruction?: { parts: GeminiPart[] };
    tools?: GeminiTool[];
    generationConfig?: {
        responseModalities?: string[];
        thinkingConfig?: {
            thinkingLevel: "minimal" | "low" | "medium" | "high";
        };
        mediaResolution?: string;
    };
}

export type KeyStatus = 'ready' | 'exhausted' | 'invalid' | 'unknown'

export interface KeyInfo {
    key: string
    status: KeyStatus
    isActive: boolean
}

/**
 * High-performance Gemini API provider with reasoning and vision support.
 */
export class Gemini3Provider implements LLMProvider {
    readonly id = "gemini-3"
    readonly manifest = {
        name: "GEMINI API",
        description: "Advanced Reasoning, High Speed & High-Fidelity Vision.",
        icon: "✨",
        getKeyUrl: "https://aistudio.google.com/app/apikey",
        docsUrl: "https://ai.google.dev/gemini-api/docs/thinking"
    }
    readonly requiresKey = true
    readonly requiresUrl = false

    private keyRing: string[] = []
    private keyStatus: KeyStatus[] = []
    private activeKeyIndex: number = 0
    private config: Nullable<ProviderConfig> = null

    // Reasoning state persistence
    private lastThoughtSignature: Nullable<string> = null

    private static readonly REASONING_MODEL = "gemini-3-flash-preview"
    private static readonly VISION_MODEL = "gemini-3-pro-image-preview"
    private static readonly SIG_STORAGE_KEY = "odie_gemini3_thought_sig"

    configure(config: ProviderConfig): void {
        this.config = config
        this.keyRing = config.keyLibrary || []
        this.keyStatus = this.keyRing.map(() => 'unknown' as KeyStatus)
        if (config.apiKey && !this.keyRing.includes(config.apiKey)) {
            this.keyRing.unshift(config.apiKey)
            this.keyStatus.unshift('unknown')
        }
        this.activeKeyIndex = 0

        // Restore state from storage
        if (isAbsent(this.lastThoughtSignature)) {
            try {
                const stored = localStorage.getItem(Gemini3Provider.SIG_STORAGE_KEY)
                if (isDefined(stored)) this.lastThoughtSignature = stored
            } catch (e: unknown) { }
        }
    }

    getKeyStatuses(): KeyInfo[] {
        return this.keyRing.map((key, idx) => ({
            key: '•••' + key.slice(-4),
            status: this.keyStatus[idx] || 'unknown',
            isActive: idx === this.activeKeyIndex
        }))
    }

    private get currentKey(): string {
        return this.keyRing[this.activeKeyIndex] || ""
    }

    private markCurrentKey(status: KeyStatus) {
        this.keyStatus[this.activeKeyIndex] = status
    }

    private rotateKey(): boolean {
        if (this.keyRing.length <= 1) return false
        this.markCurrentKey('exhausted')
        let attempts = 0
        while (attempts < this.keyRing.length) {
            this.activeKeyIndex = (this.activeKeyIndex + 1) % this.keyRing.length
            const nextStatus = this.keyStatus[this.activeKeyIndex]
            if (nextStatus !== 'exhausted' && nextStatus !== 'invalid') return true
            attempts++
        }
        return false
    }

    private isImageRequest(messages: Message[]): boolean {
        const lastUserMsg = [...messages].reverse().find(m => m.role === "user")
        if (!lastUserMsg?.content) return false
        const text = lastUserMsg.content.toLowerCase()
        const imagePatterns = [
            /\b(visualize|draw|render|sketch|schematic|diagram|blueprint|infographic|chart|graph)\b/i,
            /\b(show me|generate image|create image|make an image)\b/i,
            /\b(create a|generate a)\b.*\b(visual|image|picture|photo|infographic|diagram)\b/i
        ]
        return imagePatterns.some(pattern => pattern.test(text))
    }

    async validate(): Promise<{ ok: boolean, message: string, status?: 'valid' | 'exhausted' | 'invalid' }> {
        if (this.keyRing.length === 0) return { ok: false, message: "No API Keys provided", status: 'invalid' }

        try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${Gemini3Provider.REASONING_MODEL}?key=${this.currentKey}`
            const response = await fetch(url)

            if (response.ok) {
                return { ok: true, message: `✓ Ready (${this.keyRing.length} Key${this.keyRing.length > 1 ? 's' : ''})`, status: 'valid' }
            }

            const err = await response.json()
            const rawMsg = err.error?.message || response.statusText

            if (response.status === 429 || rawMsg.includes('Quota') || rawMsg.includes('RESOURCE_EXHAUSTED')) {
                return { ok: false, message: "Quota exhausted.", status: 'exhausted' }
            }

            if (rawMsg.includes('API key not valid') || rawMsg.includes('API_KEY_INVALID')) {
                return { ok: false, message: "Invalid API key.", status: 'invalid' }
            }

            return { ok: false, message: rawMsg, status: 'invalid' }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            return { ok: false, message: msg, status: 'invalid' }
        }
    }

    streamChat(
        messages: Message[],
        context?: unknown,
        tools?: LLMTool[],
        onFinal?: (msg: Message) => void,
        onStatusChange?: (status: string, model?: string) => void
    ): ObservableValue<{ content: string; thoughts?: string }> {
        const responseText = new DefaultObservableValue<{ content: string; thoughts?: string }>({ content: "" })

        if (this.keyRing.length === 0) {
            responseText.setValue({ content: "⚠️ No API keys configured." })
            return responseText
        }

        const run = async () => {
            try {
                if (onStatusChange) onStatusChange("Thinking...", "Gemini API")
                await this.executeRequest(messages, context, tools, responseText, onFinal, onStatusChange)
            } catch (e: unknown) {
                const err = e instanceof Error ? e.message : String(e)
                if (err.includes("429") || err.includes("Quota")) {
                    if (this.rotateKey()) {
                        await run()
                        return
                    }
                }
                responseText.setValue({ content: `**Error**\n\n${err}` })
            }
        }

        this.runStream(run)
        return responseText
    }

    private async executeRequest(
        messages: Message[],
        context: unknown,
        tools: LLMTool[] | undefined,
        responseText: DefaultObservableValue<{ content: string; thoughts?: string }>,
        onFinal?: (msg: Message) => void,
        onStatusChange?: (status: string, model?: string) => void
    ) {
        // Prepare contents
        const contents = messages
            .filter(m => m.role !== 'system')
            .map(m => {
                const parts: GeminiPart[] = []
                let sig = (m.customData?.thoughtSignature || m.customData?.thought_signature) as string | undefined

                if (isAbsent(sig) && m.role === 'model' && isDefined(this.lastThoughtSignature)) {
                    sig = this.lastThoughtSignature
                }

                if (m.role === 'function' || (m.role as string) === 'tool') {
                    try {
                        const response = typeof m.content === 'string' ? JSON.parse(m.content) : m.content
                        parts.push({
                            functionResponse: {
                                name: m.name || "unknown",
                                response: response || {}
                            }
                        })
                    } catch (e: unknown) {
                        parts.push({ text: m.content })
                    }
                } else if (isDefined(m.content)) {
                    parts.push({ text: m.content })
                }

                if (m.tool_calls) {
                    m.tool_calls.forEach((tc, idx) => {
                        const part: GeminiPart = {
                            functionCall: { name: tc.name, args: tc.arguments }
                        }
                        if (isDefined(sig) && idx === 0) {
                            (part.functionCall as any).thoughtSignature = sig
                        }
                        parts.push(part)
                    })
                }

                const role = m.role === 'model' || (m.role as string) === 'assistant' ? 'model' : 'user'
                return { role, parts }
            }) as GeminiContent[]

        const wantsImage = this.isImageRequest(messages)
        const activeModel = wantsImage ? Gemini3Provider.VISION_MODEL : Gemini3Provider.REASONING_MODEL

        let geminiTools: GeminiTool[] | undefined
        if (tools && !wantsImage) {
            geminiTools = [{
                functionDeclarations: tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }))
            }]
        }

        const systemMsg = messages.find(m => m.role === "system")
        const baseIdentity = systemMsg ? systemMsg.content : ""
        const systemPromptText = context ? JSON.stringify(context) : ""

        const toolProtocol = `\n\nUse tools for DAW control (playback, tracks, mixer) and UI widgets when requested.`
        const systemInstruction = {
            parts: [{ text: baseIdentity + "\n\n" + systemPromptText + toolProtocol }]
        }

        let finalContents = contents

        if (wantsImage) {
            if (onStatusChange) onStatusChange("Reasoning...", "Gemini API")

            const directorPrompt = `Analyze the audio concept and design a clear educational schematic. Output ONLY the visual description.`
            const reasonUrl = `https://generativelanguage.googleapis.com/v1beta/models/${Gemini3Provider.REASONING_MODEL}:generateContent?key=${this.currentKey}`

            const reasonRes = await fetch(reasonUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: directorPrompt }] }] })
            })

            let visualBlueprint = "Technical diagram"
            if (reasonRes.ok) {
                const data = await reasonRes.json()
                const blueprint = data.candidates?.[0]?.content?.parts?.[0]?.text
                if (blueprint) visualBlueprint = blueprint
            }

            if (onStatusChange) onStatusChange("Generating...", "Gemini API")
            finalContents = [{
                role: "user",
                parts: [{ text: `[GENERATE_IMAGE] ${visualBlueprint}` }]
            }] as unknown as GeminiContent[]
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:streamGenerateContent?key=${this.currentKey}`
        const requestPayload: GeminiRequest = {
            contents: finalContents,
            system_instruction: systemInstruction,
            tools: geminiTools,
            generationConfig: wantsImage ? undefined : {
                thinkingConfig: { thinkingLevel: this.config?.thinkingLevel || "low" }
            }
        }

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload)
        })

        if (!response.ok) throw new Error(`API Error: ${response.status}`)
        if (!response.body) throw new Error("Empty response")

        const reader = response.body.getReader()
        const decoder = new TextDecoder("utf-8")
        let buffer = ""
        let accumulatedText = ""
        let capturedSignature: string | null = null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Gemini API response structure is dynamic
        const capturedTools: { name: string; arguments: any }[] = []

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- API response chunk parsing requires flexible access
        const processChunk = (chunk: any) => {
            const candidate = chunk.candidates?.[0]
            const parts = candidate?.content?.parts || []

            for (const part of parts) {
                if (part.text && !part.thought) {
                    accumulatedText += part.text
                    responseText.setValue({ content: accumulatedText })
                }

                if (part.thoughtSignature) {
                    capturedSignature = part.thoughtSignature
                    this.lastThoughtSignature = capturedSignature
                    try {
                        if (isDefined(capturedSignature)) {
                            localStorage.setItem(Gemini3Provider.SIG_STORAGE_KEY, capturedSignature)
                        }
                    } catch (e: unknown) { }
                }

                if (part.inlineData?.mimeType.startsWith('image/')) {
                    const mdImage = `\n![Image](data:${part.inlineData.mimeType};base64,${part.inlineData.data})\n`
                    accumulatedText += mdImage
                    responseText.setValue({ content: accumulatedText })
                }

                if (part.functionCall) {
                    if (part.functionCall.name === "render_widget") {
                        const widgetPayload = {
                            type: "ui_component",
                            component: part.functionCall.args.component,
                            data: part.functionCall.args.data
                        }
                        accumulatedText += `\n\`\`\`json\n${JSON.stringify(widgetPayload, null, 2)}\n\`\`\`\n`
                        responseText.setValue({ content: accumulatedText })
                    } else {
                        capturedTools.push({
                            name: part.functionCall.name,
                            arguments: part.functionCall.args
                        })
                    }
                }
            }
        }

        // Stream parser
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            let searchStart = 0
            while (searchStart < buffer.length) {
                const objStart = buffer.indexOf('{', searchStart)
                if (objStart === -1) break

                let depth = 0, inString = false, escaped = false, objEnd = -1
                for (let i = objStart; i < buffer.length; i++) {
                    const char = buffer[i]
                    if (escaped) { escaped = false; continue }
                    if (char === '\\' && inString) { escaped = true; continue }
                    if (char === '"') { inString = !inString; continue }
                    if (!inString) {
                        if (char === '{') depth++
                        else if (char === '}') {
                            depth--
                            if (depth === 0) { objEnd = i + 1; break }
                        }
                    }
                }

                if (objEnd === -1) break
                const jsonStr = buffer.substring(objStart, objEnd)
                try {
                    processChunk(JSON.parse(jsonStr))
                } catch (e: unknown) { }
                searchStart = objEnd
            }
            if (searchStart > 0) buffer = buffer.substring(searchStart)
        }

        if (onFinal) {
            const finalMsg: Message = {
                id: crypto.randomUUID(),
                role: "model",
                content: accumulatedText,
                timestamp: Date.now(),
                customData: capturedSignature ? { thoughtSignature: capturedSignature } : undefined
            }

            if (capturedTools.length > 0) {
                // Fix: Correctly map captured arguments to tool_calls
                finalMsg.tool_calls = capturedTools.map(fc => ({
                    id: "call_" + crypto.randomUUID().substring(0, 8),
                    name: fc.name,
                    arguments: fc.arguments
                }))
            }
            onFinal(finalMsg)
        }
    }

    private async runStream(runner: () => Promise<void>) {
        await runner()
    }
}
