import { ObservableValue, DefaultObservableValue } from "@opendaw/lib-std"
import { LLMProvider, Message, ProviderConfig, LLMTool } from "./LLMProvider"

// Helper types for Gemini API
type GeminiPart =
    | { text: string }
    | { text: string }
    | { functionCall: { name: string, args: Record<string, unknown> } }
    | { functionResponse: { name: string, response: Record<string, unknown> } }
    | { inlineData: { mimeType: string, data: string } } // Native Image Output

type GeminiContent = { role: "user" | "model" | "tool"; parts: GeminiPart[] }
type GeminiTool = { functionDeclarations: unknown[] }
type GeminiRequest = {
    contents: GeminiContent[];
    systemInstruction?: { parts: GeminiPart[] };
    tools?: GeminiTool[];
    generationConfig?: {
        responseModalities?: string[];
    };
}

export type KeyStatus = 'ready' | 'exhausted' | 'invalid' | 'unknown'

export interface KeyInfo {
    key: string // Last 4 chars only for display
    status: KeyStatus
    isActive: boolean
}

export class GeminiProvider implements LLMProvider {
    readonly id = "gemini"
    readonly manifest = {
        name: "Google Gemini",
        description: "Google AI Studio (Free Tier Available)",
        icon: "✨",
        getKeyUrl: "https://aistudio.google.com/app/apikey",
        docsUrl: "https://ai.google.dev/docs"
    }
    readonly requiresKey = true
    readonly requiresUrl = false

    private keyRing: string[] = []
    private keyStatus: KeyStatus[] = []  // [ANTIGRAVITY] Per-key status tracking
    private activeKeyIndex: number = 0
    // [ANTIGRAVITY] Auto-Pilot Dual Core Architecture
    // We hardcode the best models for each task to prevent user error.
    private static readonly TEXT_MODEL = "gemini-3-flash-preview"
    private static readonly VISION_MODEL = "gemini-2.5-flash-image"

    configure(config: ProviderConfig) {
        // Load the library
        this.keyRing = config.keyLibrary || []
        // Initialize all keys as 'unknown' (ready to try)
        this.keyStatus = this.keyRing.map(() => 'unknown' as KeyStatus)

        // Backwards compatibility: If legacy single key exists and isn't in ring, add it
        if (config.apiKey && !this.keyRing.includes(config.apiKey)) {
            this.keyRing.unshift(config.apiKey)
            this.keyStatus.unshift('unknown')
        }

        // Reset index on config change
        this.activeKeyIndex = 0
    }

    // [ANTIGRAVITY] Public method to expose key statuses for UI
    getKeyStatuses(): KeyInfo[] {
        return this.keyRing.map((key, idx) => ({
            key: '•••' + key.slice(-4), // Masked for security
            status: this.keyStatus[idx] || 'unknown',
            isActive: idx === this.activeKeyIndex
        }))
    }

    private get currentKey(): string {
        return this.keyRing[this.activeKeyIndex] || ""
    }

    private markCurrentKey(status: KeyStatus) {
        this.keyStatus[this.activeKeyIndex] = status
        console.log(`🏷️ [Gemini] Key #${this.activeKeyIndex + 1} marked as: ${status.toUpperCase()}`)
    }

    private rotateKey(): boolean {
        if (this.keyRing.length <= 1) return false

        // Mark current key as exhausted before rotating
        this.markCurrentKey('exhausted')

        // Find next READY key (skip exhausted/invalid)
        let attempts = 0
        while (attempts < this.keyRing.length) {
            this.activeKeyIndex = (this.activeKeyIndex + 1) % this.keyRing.length
            const nextStatus = this.keyStatus[this.activeKeyIndex]

            // Allow 'unknown' and 'ready' keys
            if (nextStatus !== 'exhausted' && nextStatus !== 'invalid') {
                console.log(`🔄 [Gemini] Rotating to Key #${this.activeKeyIndex + 1} of ${this.keyRing.length} (Status: ${nextStatus})`)
                return true
            }
            attempts++
        }

        // All keys exhausted/invalid
        console.error(`❌ [Gemini] All ${this.keyRing.length} keys are exhausted or invalid`)
        return false
    }

    async validate(): Promise<{ ok: boolean, message: string, status?: 'valid' | 'exhausted' | 'invalid' }> {
        if (this.keyRing.length === 0) return { ok: false, message: "No API Keys provided", status: 'invalid' }

        try {
            // Validate the CURRENT key using the Text Model
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GeminiProvider.TEXT_MODEL}?key=${this.currentKey}`
            const response = await fetch(url)

            if (response.ok) {
                return { ok: true, message: `✓ Valid (Library: ${this.keyRing.length} Key${this.keyRing.length > 1 ? 's' : ''})`, status: 'valid' }
            }

            // Parse error for smart classification
            const err = await response.json()
            const rawMsg = err.error?.message || response.statusText

            // Quota Exhausted (Temporary - resets tomorrow)
            if (response.status === 429 || rawMsg.includes('Quota') || rawMsg.includes('RESOURCE_EXHAUSTED') || rawMsg.includes('exhausted')) {
                return {
                    ok: false,
                    message: "⏳ Daily quota exhausted. Resets tomorrow at midnight PT. Add more keys to continue now!",
                    status: 'exhausted'
                }
            }

            // Invalid API Key (Bad key format or doesn't exist)
            if (rawMsg.includes('API key not valid') || rawMsg.includes('API_KEY_INVALID') || rawMsg.includes('check your API key')) {
                return {
                    ok: false,
                    message: "🔑 Invalid API key. Please check and try again.",
                    status: 'invalid'
                }
            }

            // Revoked/Expired Key (Deleted in Google Console - rare)
            if (rawMsg.includes('expired') || rawMsg.includes('revoked') || rawMsg.includes('disabled')) {
                return {
                    ok: false,
                    message: "⚠️ Key has been revoked or disabled. Generate a new key at aistudio.google.com",
                    status: 'invalid'
                }
            }

            // Fallback for unknown errors
            return { ok: false, message: rawMsg, status: 'invalid' }
        } catch (e) {
            return { ok: false, message: (e instanceof Error) ? e.message : String(e), status: 'invalid' }
        }
    }

    // [ANTIGRAVITY] Validate ALL keys in the library and update their statuses
    async validateAllKeys(onProgress?: (index: number, total: number, status: KeyStatus) => void): Promise<KeyInfo[]> {
        console.log(`🔍 [Gemini] Validating all ${this.keyRing.length} keys...`)

        for (let i = 0; i < this.keyRing.length; i++) {
            const key = this.keyRing[i]
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${GeminiProvider.TEXT_MODEL}?key=${key}`

            try {
                const response = await fetch(url)

                if (response.ok) {
                    this.keyStatus[i] = 'ready'
                } else {
                    const err = await response.json()
                    const rawMsg = err.error?.message || ''

                    if (response.status === 429 || rawMsg.includes('Quota') || rawMsg.includes('RESOURCE_EXHAUSTED')) {
                        this.keyStatus[i] = 'exhausted'
                    } else if (rawMsg.includes('API key not valid') || rawMsg.includes('API_KEY_INVALID') || rawMsg.includes('expired')) {
                        this.keyStatus[i] = 'invalid'
                    } else {
                        this.keyStatus[i] = 'invalid'
                    }
                }
            } catch (e) {
                this.keyStatus[i] = 'invalid'
            }

            console.log(`  Key #${i + 1}: ${this.keyStatus[i].toUpperCase()}`)
            if (onProgress) onProgress(i, this.keyRing.length, this.keyStatus[i])
        }

        return this.getKeyStatuses()
    }


    // No fetchModels() - Auto-Pilot means no user selection

    // Check if current request needs vision capabilities
    private isImageRequest(messages: Message[]): boolean {
        // Check the last user message
        const lastUserMsg = [...messages].reverse().find(m => m.role === "user")
        if (!lastUserMsg?.content) return false

        const text = lastUserMsg.content.toLowerCase()
        console.log("🔍 [Gemini Router] Analyzing User Intent:", text)

        // 1. Explicit triggers
        if (text.includes("generate image") || text.includes("draw a") || text.includes("create a picture")) return true

        // 2. Visual terms context
        const imagePatterns = [
            /\b(visualize|draw|render|sketch|generate an image|create an image|make an image)\b/i, // Explicit Intent
            /\bshow me\b/i, // [Aggressive] "Show me..." usually implies visual in Odie

            // Domain specific visual terms
            /\b(signal flow|waveform|frequency|spectrum|spectrogram|oscilloscope|eq curve|compression curve)\b/i,
            /\b(distortion|saturation|reverb|delay|phaser|chorus|flanger)\b.*\b(visual|look|diagram|infographic)\b/i
        ]

        const isImage = imagePatterns.some(pattern => pattern.test(text))
        console.log(`🔍 [Gemini Router] Is Image Request? ${isImage}`)
        return isImage
    }

    streamChat(
        messages: Message[],
        context?: unknown,
        tools?: LLMTool[],
        onFinal?: (msg: Message) => void,
        onStatusChange?: (status: string, model?: string) => void
    ): ObservableValue<string> {
        const responseText = new DefaultObservableValue<string>("")

        if (this.keyRing.length === 0) {
            responseText.setValue("⚠️ Configuration Error: Please add keys to your Gemini Key Library.")
            return responseText
        }

        const run = async () => {
            // [ANTIGRAVITY] BULLETPROOF RETRY SYSTEM
            // - Per-minute limits: Wait and retry SAME key (it will recover)
            // - Daily exhaustion: Rotate to next key
            // - All keys dead: Show friendly message ONCE

            let keyAttempts = 0
            const maxKeyAttempts = this.keyRing.length
            let perMinuteRetries = 0
            const maxPerMinuteRetries = 3 // Retry same key 3x before rotating

            while (keyAttempts < maxKeyAttempts) {
                try {
                    if (onStatusChange) onStatusChange("Thinking...", "Gemini • 3 Flash")
                    await this.executeRequest(messages, context, tools, responseText, onFinal, onStatusChange)
                    // Success! Mark key as ready
                    this.markCurrentKey('ready')
                    return
                } catch (e: any) {
                    const errorMsg = e.message || ""
                    const isQuotaError = errorMsg.includes('429') || errorMsg.includes('Quota') || errorMsg.includes('RESOURCE_EXHAUSTED')
                    const isAuthError = errorMsg.includes('403') || errorMsg.includes('API key not valid') || errorMsg.includes('API_KEY_INVALID') || errorMsg.includes('expired')

                    if (isQuotaError && perMinuteRetries < maxPerMinuteRetries) {
                        // [ANTIGRAVITY] PER-MINUTE LIMIT - Wait and retry SAME key
                        perMinuteRetries++
                        const waitTime = perMinuteRetries * 2000 // 2s, 4s, 6s exponential backoff
                        console.log(`⏳ [Gemini] Per-minute limit hit. Waiting ${waitTime / 1000}s before retry ${perMinuteRetries}/${maxPerMinuteRetries}...`)
                        if (onStatusChange) onStatusChange("Rate limit, retrying...", "Gemini • 3 Flash")
                        await new Promise(r => setTimeout(r, waitTime))
                        continue // Retry SAME key with SAME message!
                    }

                    // Reset per-minute counter when switching keys
                    perMinuteRetries = 0

                    if (isQuotaError) {
                        // DAILY limit exhausted - rotate key
                        this.markCurrentKey('exhausted')
                    } else if (isAuthError) {
                        // Bad key - mark and skip
                        this.markCurrentKey('invalid')
                    }

                    if ((isQuotaError || isAuthError) && this.rotateKey()) {
                        keyAttempts++
                        console.log(`🔄 [Gemini] Silent rotation. Now using Key #${this.activeKeyIndex + 1}`)
                        await new Promise(r => setTimeout(r, 500))
                        continue // Try next key with SAME message!
                    } else if (isQuotaError || isAuthError) {
                        // ALL KEYS EXHAUSTED
                        console.error(`❌ [Gemini] All ${this.keyRing.length} keys exhausted`)
                        responseText.setValue("⏳ **All API keys are resting!**\n\nNo worries - this happens when the free tier daily limit is reached.\n\n**Quick Fix:** Add more free API keys!\n1. Go to [aistudio.google.com](https://aistudio.google.com/app/apikey)\n2. Click 'Create API Key'\n3. Add it in Settings → Manage Library\n\n_Keys reset at midnight Pacific Time._")
                        return
                    } else {
                        // Genuine API error (not quota/auth)
                        const status = (e as any).status || 500
                        responseText.setValue(this.formatError(status, errorMsg))
                        return
                    }
                }
            }

            // Fallback
            responseText.setValue("⏳ **All API keys are resting!**\n\nAdd more free keys in Settings → Manage Library.")
        }

        this.runStream(run)
        return responseText
    }

    // Extracted for the retry loop
    private async executeRequest(
        messages: Message[],
        context: unknown,
        tools: LLMTool[] | undefined,
        responseText: DefaultObservableValue<string>,
        onFinal?: (msg: Message) => void,
        onStatusChange?: (status: string, model?: string) => void
    ) {
        // [ANTIGRAVITY] FIX: Extract System Prompt to enforce Persona
        // The "system" message must go into `systemInstruction`, not the chat history
        const systemMsg = messages.find(m => m.role === "system")
        const chatMessages = messages.filter(m => m.role !== "system")

        // Convert OpenDAW Messages to Gemini Content
        const contents = chatMessages.map(m => {
            let role: "user" | "model" = "user"
            if (m.role === "model") role = "model"

            const parts: GeminiPart[] = []

            // Handle function responses (tool output)
            if (m.role === "function" && m.name) {
                // Parse the content as JSON result if possible
                let resultData: Record<string, unknown> = { result: m.content }
                try {
                    resultData = { result: JSON.parse(m.content) }
                } catch {
                    // Keep as string
                }
                parts.push({
                    functionResponse: {
                        name: m.name,
                        response: resultData
                    }
                })
                // [CONTEXT7 FIX] Function responses must be sent as "tool" role per Gemini API spec
                // See: https://ai.google.dev/gemini-api/docs/function-calling/tutorial
                return { role: "tool" as const, parts }
            }

            if (m.content && m.content.trim().length > 0) {
                parts.push({ text: m.content })
            }

            if (m.tool_calls && m.tool_calls.length > 0) {
                for (const tc of m.tool_calls) {
                    parts.push({
                        functionCall: {
                            name: tc.name,
                            args: tc.arguments
                        }
                    })
                }
            }

            if (parts.length === 0) return null

            return { role, parts }
        }).filter(request => request !== null) as GeminiContent[]

        // System Instruction (Persona + Context)
        const systemParts: GeminiPart[] = []

        // 1. The Soul (Odie Persona)
        if (systemMsg && systemMsg.content) {
            systemParts.push({ text: systemMsg.content })
        }

        // 2. The Facts (Project Context JSON)
        if (context) {
            systemParts.push({ text: "\n[SYSTEM DATA CONTEXT]\n" + JSON.stringify(context) })
        }

        const systemInstruction = systemParts.length > 0 ? { parts: systemParts } : undefined

        // Map Tools to Gemini Format
        let geminiTools: GeminiTool[] | undefined
        if (tools && tools.length > 0) {
            const mappedTools = tools.map(t => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters
            }))

            geminiTools = [{
                functionDeclarations: mappedTools
            }]
        }

        // 🎨 AUTO-ROUTING (Auto-Pilot)
        const wantsImage = this.isImageRequest(messages)
        const activeModel = wantsImage ? GeminiProvider.VISION_MODEL : GeminiProvider.TEXT_MODEL
        const useImageMode = wantsImage

        if (wantsImage) {
            console.log("🎨 [Gemini] Auto-routing to VISION model:", GeminiProvider.VISION_MODEL)
        } else {
            console.log("🧠 [Gemini] Auto-routing to TEXT model:", GeminiProvider.TEXT_MODEL)
        }

        // [ANTIGRAVITY] TOKEN SAFETY
        let finalContents = contents
        if (useImageMode && contents.length > 6) {
            console.log(`✂️ [Gemini] Smart Truncation: Preserving System Prompt + Last 5`)
            finalContents = [contents[0], ...contents.slice(-5)]
        }

        // 🧠 PROMPT ENHANCEMENT
        let finalSystemInstruction = systemInstruction

        // VISUAL DICTIONARY 
        const VISUAL_DICTIONARY: Record<string, string> = {
            "distortion": "VISUAL_DEFINITION: Waveform Clipping. Square tops. TEXT_LABEL: 'Distortion'.",
            "saturation": "VISUAL_DEFINITION: Soft clipping. Rounded square tops. Warm colors. TEXT_LABEL: 'Saturation'.",
            "sawtooth": "VISUAL_DEFINITION: Sharp, jagged triangular wave. Linear rise, instantaneous drop. TEXT_LABEL: 'Sawtooth'.",
            "sine": "VISUAL_DEFINITION: Smooth, perfect curve. No sharp angles. TEXT_LABEL: 'Sine'.",
            "square": "VISUAL_DEFINITION: 90-degree angles. Flat top, flat bottom. Digital look. TEXT_LABEL: 'Square'.",
            "compression": "VISUAL_DEFINITION: Dynamic range reduction. The peaks are squashed down. TEXT_LABEL: 'Compression'.",
            "eq": "VISUAL_DEFINITION: Frequency Spectrum Graph. 20Hz to 20kHz. Bell curves. TEXT_LABEL: 'EQ'.",
            "reverb": "VISUAL_DEFINITION: Dense reflections fading over time. Diffusion. Cloud-like. TEXT_LABEL: 'Reverb'.",
            "delay": "VISUAL_DEFINITION: Distinct, repeating echoes fading out. Rhythmic. TEXT_LABEL: 'Delay'.",
            "phaser": "VISUAL_DEFINITION: Sweeping peaks and notches (Comb Filter) moving over time. TEXT_LABEL: 'Phaser'.",
            "lfo": "VISUAL_DEFINITION: Low Frequency Oscillator. Slow moving wave modulating a parameter. TEXT_LABEL: 'LFO'.",
            "low pass": "VISUAL_DEFINITION: Filter Curve. High frequencies rolled off. Downward slope. TEXT_LABEL: 'Low Pass'.",
            "high pass": "VISUAL_DEFINITION: Filter Curve. Low frequencies rolled off. Upward slope. TEXT_LABEL: 'High Pass'."
        }

        let conceptVisuals = ""
        // Scan the *User's Request* for dictionary keys
        const lastUserMsgForScan = finalContents[finalContents.length - 1]

        let lastUserText = ""
        if (lastUserMsgForScan && lastUserMsgForScan.role === 'user') {
            const p = lastUserMsgForScan.parts[0]
            if (p && 'text' in p) {
                lastUserText = p.text.toLowerCase()
            }
        }

        if (lastUserText) {
            const foundConcepts: string[] = []
            Object.keys(VISUAL_DICTIONARY).forEach(key => {
                if (lastUserText.includes(key)) foundConcepts.push(VISUAL_DICTIONARY[key])
            })
            if (foundConcepts.length > 0) conceptVisuals = "\nVISUAL DICTIONARY INJECTIONS:\n" + foundConcepts.join("\n")
        }


        if (useImageMode) {
            // [ANTIGRAVITY] EXPERT ART DIRECTOR PROTOCOL (Ag-X1 + Educational)
            // STEP 1: REASONING (Gemini 3)
            if (onStatusChange) onStatusChange("Reasoning...", "Gemini • 3 Flash")

            // Extract Project Context
            let projectRef = "No Project Context Available."
            const sysPart = systemInstruction?.parts[0]
            if (sysPart && 'text' in sysPart) {
                projectRef = sysPart.text
            }

            // Extract User Request
            let userReq = "Abstract Visual"
            const lastUserMsg = contents.slice().reverse().find(c => c.role === 'user')
            if (lastUserMsg && lastUserMsg.parts[0] && 'text' in lastUserMsg.parts[0]) {
                userReq = lastUserMsg.parts[0].text
            }

            const DIRECTOR_PROMPT = `
            [ROLE: EXPERT AUDIO VISUALIZATION DIRECTOR]
            You are an expert in Audio Engineering, Music Theory, and Digital Signal Processing.
            The user wants to LEARN. Do not generate "abstract art". Generate "Educational Schematic" and "Diagrams".
            We need clear signal flows, vector-style layouts, and clean visual explanations.

            [PROJECT CONTEXT]
            ${projectRef}

            [USER REQUEST]
            ${userReq}

            [VISUAL DICTIONARY]
            ${conceptVisuals}

            [TASK]
            1. Analyze the technical concept (e.g., signal flow, frequency spectrum, sidechaining).
            2. Design a VISUAL DIAGRAM or SCHEMATIC that explains it.
            3. Output ONLY the detailed prompt for the layout/renderer.
            4. KEYWORDS TO USE: "Schematic", "Diagram", "Infographic", "Cross-section", "Signal Flow", "Vector Style", "Whiteboard", "Technical Illustration".
            5. NEGATIVE PROMPTS (Avoid): "Photorealistic", "Abstract", "Artistic", "Vague", "Generic", "3D Render", "Glossy".
            6. Do not output JSON. Just the visual description.
            `

            // Execute STEP 1 (Reasoning)
            console.log("🧠 [Gemini Art Director] Reasoning...")
            const reasonUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GeminiProvider.TEXT_MODEL}:generateContent?key=${this.currentKey}`

            const reasonRes = await fetch(reasonUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: DIRECTOR_PROMPT }] }]
                })
            })

            let visualBlueprint = userReq // Fallback
            if (reasonRes.ok) {
                const reasonData = await reasonRes.json()
                const blueprint = reasonData.candidates?.[0]?.content?.parts?.[0]?.text
                if (blueprint) {
                    visualBlueprint = blueprint + " Style: Technical Schematic, Clean Lines, Bauhaus, Educational."
                    console.log("🧠 [Gemini Art Director] Blueprint Created:", visualBlueprint.substring(0, 50) + "...")
                }
            } else {
                console.error("🧠 [Gemini Art Director] Failed to reason. Fallback to raw request.")
            }


            // STEP 2: RENDERING (Gemini 2.5)
            // The Vision Model executes the blueprint.
            if (onStatusChange) onStatusChange("Painting...", "Gemini • Nano Banana")

            const VISUAL_STYLE_GUIDE = `
            [SYSTEM_INSTRUCTION: VISUAL_RENDERER_PROCESS]
            MODE: NATIVE_IMAGE_GENERATION_V5
            STATUS: ACTIVE
            
            CMD: GENERATE_PIXEL_DATA
            OUTPUT: IMAGE/PNG (Native Inline Data)
            
            Visual Standards:
            - **Style: Technical, Schematic, Educational, Clean, High Contrast.**
            - **Palette:** Deep Void (#0f172a) used for background only. Vibrant Signal Colors (Neon Blue, Hot Pink, Electric Green).
            - **Typography:** STRICT, Clean, Spelled Correctly.

            CRITICAL PROTOCOL:
            1. Fulfill the VISUAL BLUEPRINT exactly.
            2. DO NOT output JSON, XML, or "dalle" tool calls.
            3. DO NOT output "thought" blocks or reasoning text.
            4. You are DIRECTLY connected to the pixel engine.
            `

            finalSystemInstruction = { parts: [{ text: VISUAL_STYLE_GUIDE }] }

            // Rebuild contents to be SINGLE SHOT using the BLUEPRINT
            finalContents = [{
                role: "user",
                parts: [{
                    text: `[MANDATORY: GENERATE IMAGE]\nVISUAL BLUEPRINT:\n"${visualBlueprint}"\n\nGUIDANCE: detailed, 4k resolution, technical diagram.`
                }]
            }]
        }

        // [ANTIGRAVITY] FIX: Image Generation (Nano Banana) uses Unary
        const method = useImageMode ? "generateContent" : "streamGenerateContent"
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:${method}?key=${this.currentKey}`

        console.log(`[Gemini] Executing request on Key #${this.activeKeyIndex + 1}`)
        if (finalSystemInstruction) {
            console.log("[Gemini] SYSTEM INSTRUCTION:", JSON.stringify(finalSystemInstruction, null, 2))
        }

        const requestBody = {
            contents: finalContents,
            system_instruction: finalSystemInstruction,
            tools: useImageMode ? undefined : geminiTools,
            generationConfig: useImageMode ? { responseModalities: ["TEXT", "IMAGE"] } : {}
        } as GeminiRequest

        console.log("🔍 [Gemini Debug] Full Request Payload:", JSON.stringify(requestBody, null, 2))

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
        })

        if (!response.ok) {
            const errText = await response.text()
            console.error(`[Gemini Config Error Key #${this.activeKeyIndex}]`, errText)

            // Check for 429 in status OR body
            if (response.status === 429 || errText.includes("429") || errText.includes("Quota") || errText.includes("RESOURCE_EXHAUSTED")) {
                throw new Error("Quota Exceeded (429)")
            }
            throw new Error(`API Error ${response.status}: ${errText}`)
        }

        if (!response.body) throw new Error("No response body")

        // BRANCH: UNARY RESPONSE (Images)
        if (useImageMode) {
            const data = await response.json()
            const parts = data.candidates?.[0]?.content?.parts || []
            let finalContent = ""
            let imageFound = false

            // Scan all parts for Image Data first
            for (const part of parts) {
                if (part.inlineData) {
                    const { mimeType, data: b64 } = part.inlineData
                    const imgTag = `\n\n![Generated Image](data:${mimeType};base64,${b64})\n\n`
                    finalContent += imgTag
                    imageFound = true
                }
            }

            // If no image, looks for text (Hallucinations or Errors)
            // If image IS found, we can optionally include text, but usually it's just "Here is your image" noise.
            // Let's include text only if it looks substantive or if NO image found.
            if (!imageFound) {
                const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text).join("\n")

                // [ANTIGRAVITY] HALLUCINATION GUARD
                if (textParts.includes("dalle") || textParts.includes('"action":')) {
                    finalContent = "⚠️ **Image Generation Failed**\n\nThe model attempted to use an external tool instead of its native visual cortex. Please try again with a simpler prompt."
                    console.warn("[Gemini] Hallucination caught and suppressed:", textParts)
                } else {
                    finalContent = textParts || "⚠️ Logic Error: Image model returned no content."
                }
            } else {
                // Optional: Strip "Here is your image" text if we actually got an image.
                // Or just append it? Let's just output the image to be clean/premium.
                // finalContent is already set to the img tags.
            }

            responseText.setValue(finalContent)

            if (onFinal) {
                onFinal({
                    id: crypto.randomUUID(),
                    role: "model",
                    content: finalContent,
                    timestamp: Date.now()
                })
            }
            return
        }

        // BRANCH: STREAM RESPONSE (Text)
        const reader = response.body.getReader()
        const decoder = new TextDecoder("utf-8")
        let buffer = ""
        let accumulatedText = ""
        // [ANTIGRAVITY] FIX: Support MULTIPLE function calls (was singular, breaking multi-step commands)
        let capturedFunctionCalls: { name: string, args: Record<string, unknown> }[] = []

        let keepReading = true
        while (keepReading) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            // Sliding Window Parser
            let cursor = 0
            while (cursor < buffer.length) {
                const start = buffer.indexOf('{', cursor)
                if (start === -1) break

                let matchFound = false
                for (let end = start + 1; end <= buffer.length; end++) {
                    if (buffer[end - 1] !== '}') continue

                    const candidateStr = buffer.substring(start, end)
                    try {
                        const parsed = JSON.parse(candidateStr)
                        matchFound = true

                        const candidate = parsed.candidates?.[0]
                        const part = candidate?.content?.parts?.[0]

                        if (part?.text) {
                            // [ANTIGRAVITY] HALLUCINATION STRIPPER (STREAMING)
                            // Clean noise where model outputs bare JSON tools in text
                            let cleanText = part.text
                            if (cleanText.includes('"action": "dalle') || cleanText.includes('dalle.text2im')) {
                                console.warn("[Gemini] Stripping DALL-E hallucination from stream")
                                cleanText = cleanText.replace(/\{[\s\S]*"action":\s*"dalle[\s\S]*\}/g, "")
                                    .replace(/```json[\s\S]*dalle[\s\S]*```/g, "")
                                // Fallback: If it's just the JSON block, ignore it entirely
                                if (cleanText.includes('"action":')) cleanText = ""
                            }

                            if (cleanText) {
                                accumulatedText += cleanText
                                responseText.setValue(accumulatedText)
                            }
                        }
                        if (part?.inlineData) {
                            const { mimeType, data } = part.inlineData
                            const imgTag = `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`
                            accumulatedText += imgTag
                            responseText.setValue(accumulatedText)
                        }
                        // [ANTIGRAVITY] FIX: Capture ALL function calls, not just the last one
                        if (part?.functionCall) {
                            capturedFunctionCalls.push(part.functionCall)
                            console.log(`[Gemini] Captured tool call ${capturedFunctionCalls.length}: ${part.functionCall.name}`)
                        }

                        cursor = end
                        break
                    } catch (e) { continue }
                }
                if (!matchFound) break
            }
            if (cursor > 0) buffer = buffer.substring(cursor)
        }

        // End of Stream - Send ALL captured function calls
        if (capturedFunctionCalls.length > 0 && onFinal) {
            console.log(`[Gemini] Sending ${capturedFunctionCalls.length} tool call(s) to execution`)
            const toolMsg: Message = {
                id: crypto.randomUUID(),
                role: "model",
                content: "",
                timestamp: Date.now(),
                tool_calls: capturedFunctionCalls.map(fc => ({
                    id: "call_" + crypto.randomUUID().substring(0, 8),
                    name: fc.name,
                    arguments: fc.args
                }))
            }
            onFinal(toolMsg)
        }
        else if (onFinal) {
            const textMsg: Message = {
                id: crypto.randomUUID(),
                role: "model",
                content: accumulatedText,
                timestamp: Date.now()
            }
            onFinal(textMsg)
        }
    }


    private async runStream(runner: () => Promise<void>) {
        await runner()
    }

    /**
     * [ANTIGRAVITY] Convert ALL errors into friendly, Odie-style messages
     * USER NEVER SEES: JSON, status codes, stack traces, or technical jargon
     */
    private formatError(status: number, rawText: string): string {
        const lowerText = rawText.toLowerCase()

        // ============================================
        // TOKEN / CONTEXT WINDOW EXCEEDED
        // ============================================
        if (lowerText.includes('token') && (lowerText.includes('exceed') || lowerText.includes('maximum') || lowerText.includes('limit'))) {
            return `🧠 **Whoa, that's a lot to think about!**

I got a bit overwhelmed by all that information. Let's try again with a shorter message.

_Tip: Break complex requests into smaller parts - I'll remember what we talked about!_`
        }

        // ============================================
        // RATE LIMIT / QUOTA
        // ============================================
        if (status === 429 || lowerText.includes('quota') || lowerText.includes('rate') || lowerText.includes('resource_exhausted')) {
            return `⏳ **One sec, catching my breath!**

I'm handling a lot of requests right now. Just give me a moment and try again.

_I'm still here for you!_`
        }

        // ============================================
        // INVALID API KEY
        // ============================================
        if (status === 401 || status === 403 || lowerText.includes('api key') || lowerText.includes('api_key_invalid') || lowerText.includes('unauthorized')) {
            return `🔑 **Hmm, my connection isn't working**

There might be an issue with the API key. Head to Settings to check it out!

_Need a new key? Visit aistudio.google.com_`
        }

        // ============================================
        // NETWORK ERROR / FAILED TO FETCH
        // ============================================
        if (lowerText.includes('failed to fetch') || lowerText.includes('network') || lowerText.includes('timeout') || lowerText.includes('econnrefused')) {
            return `📡 **Can't reach the cloud right now**

My brain is in the cloud, and we seem to have lost connection. Check your internet and try again!

_Or switch to Ollama in Settings for offline mode._`
        }

        // ============================================
        // SERVER ERRORS (5xx)
        // ============================================
        if (status >= 500) {
            return `🔧 **Google's having a moment**

The AI servers are a bit overloaded right now. This usually fixes itself in a minute.

_Try again soon - I'll be right here!_`
        }

        // ============================================
        // BAD REQUEST (400) - CATCH ALL
        // ============================================
        if (status === 400) {
            return `🤔 **Something went a bit sideways**

I couldn't quite process that request. Try rephrasing or breaking it into simpler parts.

_I'm always learning!_`
        }

        // ============================================
        // GENERIC FALLBACK - STILL FRIENDLY
        // ============================================
        return `💭 **Oops, hit a little snag!**

Something unexpected happened, but no worries - just try again!

_If this keeps happening, check Settings or restart the app._`
    }
}
