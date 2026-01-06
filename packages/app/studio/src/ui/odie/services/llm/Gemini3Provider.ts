import { ObservableValue, DefaultObservableValue } from "@opendaw/lib-std"
import { LLMProvider, Message, ProviderConfig, LLMTool } from "./LLMProvider"

// [GEMINI 3 SPEC] Protocol Buffers & Types
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
        mediaResolution?: "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH" | "MEDIA_RESOLUTION_ULTRA_HIGH";
    };
}

export type KeyStatus = 'ready' | 'exhausted' | 'invalid' | 'unknown'

export interface KeyInfo {
    key: string
    status: KeyStatus
    isActive: boolean
}

/**
 * [GEMINI 3 CORTEX]
 * The "System 2" Brain.
 * 
 * Major Upgrades:
 * 1. Echo Protocol: Captures and injects `thoughtSignature` to maintain reasoning state.
 * 2. Thinking Levels: Explicit control over "Cognitive Depth".
 * 3. State Machine Parser: Handles interleaved Thoughts/Tools and Binary Blobs.
 * 4. Nano Banana: Ultra-High resolution visual routing.
 */
export class Gemini3Provider implements LLMProvider {
    readonly id = "gemini-3" // Distinct ID for safety
    readonly manifest = {
        name: "Gemini 3 (Cognitive)",
        description: "Review Mode Only. Features 'Thinking' & 'Echo Protocol'.",
        icon: "🧠",
        getKeyUrl: "https://aistudio.google.com/app/apikey",
        docsUrl: "https://ai.google.dev/gemini-api/docs/thinking"
    }
    readonly requiresKey = true
    readonly requiresUrl = false

    private keyRing: string[] = []
    private keyStatus: KeyStatus[] = []
    private activeKeyIndex: number = 0
    private config: ProviderConfig | undefined

    // [STATE] The Cognitive Cookie
    // We must persist this between turns for the SAME session.
    private lastThoughtSignature: string | null = null

    // Models
    private static readonly REASONING_MODEL = "gemini-3-flash-preview"
    private static readonly VISION_MODEL = "gemini-3-pro-image-preview"

    // [A2UI PERSISTENCE] Storage key for cross-refresh signature persistence
    private static readonly SIG_STORAGE_KEY = "odie_gemini3_thought_sig"

    configure(config: ProviderConfig) {
        this.config = config
        this.keyRing = config.keyLibrary || []
        this.keyStatus = this.keyRing.map(() => 'unknown' as KeyStatus)
        if (config.apiKey && !this.keyRing.includes(config.apiKey)) {
            this.keyRing.unshift(config.apiKey)
            this.keyStatus.unshift('unknown')
        }
        this.activeKeyIndex = 0

        // [A2UI FIX] Restore thought signature from localStorage if we don't have one
        if (!this.lastThoughtSignature) {
            try {
                const stored = localStorage.getItem(Gemini3Provider.SIG_STORAGE_KEY)
                if (stored) {
                    this.lastThoughtSignature = stored
                    console.log("🧠 [Echo Protocol] Restored signature from storage.")
                }
            } catch (e) {
                // Ignore storage errors (e.g., private browsing)
            }
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

    // [ROUTER] Detecting Visual Intent
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
            // [GEMINI 3] Retry Logic (Simplified for V2)
            try {
                if (onStatusChange) onStatusChange("Thinking...", "Gemini • 3 System 2")
                await this.executeRequest(messages, context, tools, responseText, onFinal, onStatusChange)
            } catch (e: any) {
                const err = e.message || String(e)
                if (err.includes("429") || err.includes("Quota")) {
                    if (this.rotateKey()) {
                        await run() // Retry with new key
                        return
                    }
                }
                responseText.setValue(`🧠 **Cognitive Error**\n\n${err}`)
            }
        }

        this.runStream(run)
        return responseText
    }

    private async executeRequest(
        messages: Message[],
        context: unknown,
        tools: LLMTool[] | undefined,
        responseText: DefaultObservableValue<string>,
        onFinal?: (msg: Message) => void,
        onStatusChange?: (status: string, model?: string) => void
    ) {
        if (onStatusChange) onStatusChange("Thinking...", "Gemini 3 Cognitive")

        // [1] CONVERT MESSAGES & INJECT SIGNATURE
        const contents = messages
            .filter(m => m.role !== 'system')
            .map(m => {
                const parts: GeminiPart[] = []

                // [ECHO REHYDRATION]
                let sig = (m.customData?.thoughtSignature || m.customData?.thought_signature) as string | undefined

                // [FIX] Use live state if history lacks it (for current turn continuity)
                if (!sig && m.role === 'model' && this.lastThoughtSignature) {
                    sig = this.lastThoughtSignature
                }

                if (m.role === 'function') {
                    // Tool response turn
                    try {
                        const response = typeof m.content === 'string' ? JSON.parse(m.content) : m.content
                        parts.push({
                            functionResponse: {
                                name: m.name || "unknown",
                                response: response || {}
                            }
                        })
                    } catch (e) {
                        parts.push({ text: m.content }) // Fallback
                    }
                } else {
                    if (m.content) parts.push({ text: m.content })
                }

                if (m.tool_calls) {
                    m.tool_calls.forEach((tc, classIdx) => {
                        const part: GeminiPart = {
                            functionCall: { name: tc.name, args: tc.arguments }
                        }
                        // [ECHO PROTOCOL] Only the FIRST function call in a block should contain the signature
                        if (sig && classIdx === 0) {
                            (part as any).thoughtSignature = sig
                        }
                        parts.push(part)
                    })
                }

                // [FIX] Gemini API uses 'user' for both user messages and function responses
                const role = m.role === 'model' || (m.role as any) === 'assistant' ? 'model' : 'user'
                return { role, parts }
            }) as GeminiContent[]

        // [2] ROUTING & CONFIG
        const wantsImage = this.isImageRequest(messages)
        const activeModel = wantsImage ? Gemini3Provider.VISION_MODEL : Gemini3Provider.REASONING_MODEL

        // [GEMINI 3] RESTORED: VISUAL DICTIONARY (Domain Knowledge)
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
        const lastUserMsgForScan = contents.slice().reverse().find(m => m.role === 'user')
        let lastUserText = ""
        if (lastUserMsgForScan && lastUserMsgForScan.parts[0] && 'text' in lastUserMsgForScan.parts[0]) {
            lastUserText = (lastUserMsgForScan.parts[0] as any).text.toLowerCase()
        }

        if (lastUserText) {
            const foundConcepts: string[] = []
            Object.keys(VISUAL_DICTIONARY).forEach(key => {
                if (lastUserText.includes(key)) foundConcepts.push(VISUAL_DICTIONARY[key])
            })
            if (foundConcepts.length > 0) conceptVisuals = "\nVISUAL DICTIONARY INJECTIONS:\n" + foundConcepts.join("\n")
        }

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

        // [3] STRICT SYSTEM INSTRUCTION (Anti-Hallucination)
        // [GEMINI 3] FIX: Inject the CORE IDENTITY from the messages array
        const systemMsg = messages.find(m => m.role === "system")
        const baseIdentity = systemMsg ? systemMsg.content : ""

        const systemPromptText = context ? JSON.stringify(context) : ""
        const toolProtocol = `
[TOOL PROTOCOL]
1. 🎛️ APP CONTROL: You have access to a suite of DAW tools. USE THEM immediately when requested:
   - 'add_track', 'add_effect', 'add_instrument'
   - 'set_device_param', 'transport_control'
   - 'save_project', 'import_audio'
   Do not describe the action—EXECUTE IT.

2. 🎨 UI GENERATION: For visual components, you MUST use the 'render_widget' tool.
   - Schema: { component: "smart_knob" | "comparison_table" ..., data: { ... } }

3. ⛔ RESTRICTIONS: DO NOT invent tools outside of the provided function declarations.`

        let systemInstruction = {
            parts: [{ text: baseIdentity + "\n\n" + systemPromptText + toolProtocol }]
        }

        // [GEMINI 3] RESTORED: MULTI-STAGE REASONING PIPELINE (Visual Director)
        let finalContents = contents

        if (wantsImage) {
            // STEP 1: REASONING (Gemini 3 Flash)
            if (onStatusChange) onStatusChange("Reasoning...", "Gemini • 3 Flash")

            const DIRECTOR_PROMPT = `
            [ROLE: EXPERT AUDIO VISUALIZATION DIRECTOR]
            You are an expert in Audio Engineering, Music Theory, and Digital Signal Processing.
            The user wants to LEARN. Do not generate "abstract art". Generate "Educational Schematic" and "Diagrams".
            We need clear signal flows, vector-style layouts, and clean visual explanations.

            [PROJECT CONTEXT]
            ${systemPromptText.substring(0, 1000)}...

            [USER REQUEST]
            ${lastUserText}

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

            console.log("🧠 [Gemini 3 Visual Reasoning] Reasoning...")
            const reasonUrl = `https://generativelanguage.googleapis.com/v1beta/models/${Gemini3Provider.REASONING_MODEL}:generateContent?key=${this.currentKey}`

            const reasonRes = await fetch(reasonUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: DIRECTOR_PROMPT }] }]
                })
            })

            let visualBlueprint = lastUserText // Fallback
            if (reasonRes.ok) {
                const reasonData = await reasonRes.json()
                const blueprint = reasonData.candidates?.[0]?.content?.parts?.[0]?.text
                if (blueprint) {
                    visualBlueprint = blueprint + " Style: Technical Schematic, Clean Lines, Bauhaus, Educational."
                    console.log("🧠 [Gemini 3 Visual Reasoning] Blueprint Created:", visualBlueprint.substring(0, 50) + "...")
                }
            } else {
                console.error("🧠 [Gemini 3 Visual Reasoning] Failed to reason. Fallback to raw request.")
            }

            // STEP 2: RENDERING (Nano Banana Pro)
            if (onStatusChange) onStatusChange("Painting...", "Nano Banana Pro")

            const VISUAL_STYLE_GUIDE = `
            [SYSTEM_INSTRUCTION: VISUAL_RENDERER_PROCESS]
            MODE: NATIVE_IMAGE_GENERATION_V5 (Nano Banana)
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

            // Override System Instruction for the Vision Model
            systemInstruction = { parts: [{ text: VISUAL_STYLE_GUIDE }] }

            // Rebuild contents to be SINGLE SHOT using the BLUEPRINT
            finalContents = [{
                role: "user",
                parts: [{
                    text: `[MANDATORY: GENERATE IMAGE]\nVISUAL BLUEPRINT:\n"${visualBlueprint}"\n\nGUIDANCE: detailed, 4k resolution, technical diagram.`
                }]
            }] as any
        }

        // [3] EXECUTE STREAM
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:streamGenerateContent?key=${this.currentKey}`

        console.log(`🧠 [Gemini 3] Requesting ${activeModel}...`)

        const requestPayload: GeminiRequest = {
            contents: finalContents,
            system_instruction: systemInstruction,
            tools: geminiTools,
            generationConfig: wantsImage ? undefined : {
                thinkingConfig: {
                    thinkingLevel: this.config?.thinkingLevel || "low"
                }
                // [GEMINI 3] FIX: Removed 'mediaResolution' (API 400 Invalid Argument)
            }
        }

        console.log("🔍 [Gemini 3 Debug] Full Request Payload:", JSON.stringify(requestPayload, null, 2))

        // [PROMPT TRACER] Verification that the "Real" system is engaged
        if (systemInstruction && systemInstruction.parts) {
            const sysText = systemInstruction.parts[0].text
            console.groupCollapsed("🧠 [Gemini 3 Prompt Tracer]")
            console.log("📝 Base Identity:", sysText.slice(0, 50) + "...")
            console.log("🕵️ Context Scanner:", conceptVisuals ? "ACTIVE (Injected)" : "INACTIVE (No keywords)")
            console.log("🎨 Visual Reasoning:", wantsImage ? "ACTIVE (Reasoning)" : "STANDBY")
            console.log("🛠️ Tool Protocol:", sysText.includes("[TOOL PROTOCOL]") ? "VERIFIED" : "MISSING")
            console.log("📦 Full System Prompt:", sysText)
            console.groupEnd()
        }

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestPayload)
        })

        if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`)
        if (!response.body) throw new Error("No Body")

        // [4] JSONL STREAMING PARSER (A2UI Compliant)
        // The API returns newline-delimited JSON objects wrapped in an array.
        // We buffer incoming data and split by valid JSON objects.
        const reader = response.body.getReader()
        const decoder = new TextDecoder("utf-8")
        let buffer = ""
        let accumulatedText = ""
        let capturedSignature: string | null = null
        const capturedTools: any[] = []

        // Helper: Process a single parsed chunk
        const processChunk = (chunk: any) => {
            const candidate = chunk.candidates?.[0]
            const parts = candidate?.content?.parts || []

            for (const part of parts) {
                if (part.text) {
                    if (part.thought) {
                        // [GEMINI 3] Visual Thought Block (Markdown Safe)
                        const thoughtBlock = `\n> 🧠 **THINKING PROCESS**\n> ${part.text.replace(/\n/g, '\n> ')}\n\n`
                        accumulatedText += thoughtBlock
                    } else {
                        accumulatedText += part.text
                    }
                    responseText.setValue(accumulatedText)
                }

                // [ECHO PROTOCOL] Capture!
                if (part.thoughtSignature) {
                    console.log("🧠 [Echo Protocol] Captured Signature Blob!")
                    capturedSignature = part.thoughtSignature
                    this.lastThoughtSignature = capturedSignature

                    // [A2UI FIX] Persist to localStorage for cross-refresh survival
                    try {
                        if (capturedSignature) {
                            localStorage.setItem(Gemini3Provider.SIG_STORAGE_KEY, capturedSignature)
                        }
                    } catch (e) {
                        // Ignore storage errors
                    }
                }

                // [VISUAL CORTEX] Image Blob Detection
                if (part.inlineData && part.inlineData.mimeType.startsWith('image/')) {
                    const mdImage = `\n![Generated Image](data:${part.inlineData.mimeType};base64,${part.inlineData.data})\n`
                    accumulatedText += mdImage
                    responseText.setValue(accumulatedText)
                    console.log("🎨 [Gemini 3 Visual Cortex] Image Blob Captured & Rendered")
                }

                // [GEN UI 2.0] Widget Interception
                if (part.functionCall && part.functionCall.name === "render_widget") {
                    console.log("⚡ [Gemini 3 Gen UI] Intercepting Widget Call:", part.functionCall.args)
                    const widgetPayload = {
                        type: "ui_component",
                        component: part.functionCall.args.component,
                        data: part.functionCall.args.data
                    }
                    const mdWidget = `\n\`\`\`json\n${JSON.stringify(widgetPayload, null, 2)}\n\`\`\`\n`
                    accumulatedText += mdWidget
                    responseText.setValue(accumulatedText)
                } else if (part.functionCall) {
                    // Normal Tool Call (Backend execution)
                    capturedTools.push({
                        name: part.functionCall.name,
                        arguments: part.functionCall.args
                    })
                }
            }
        }

        // [A2UI JSONL PARSER] Stream processing with bracket-depth tracking
        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            // Try to extract complete JSON objects from buffer
            // Gemini API streams as: [{...}\n,{...}\n,{...}]
            // We extract individual {...} objects
            let searchStart = 0
            while (searchStart < buffer.length) {
                const objStart = buffer.indexOf('{', searchStart)
                if (objStart === -1) break

                // Track bracket depth to find complete object
                let depth = 0
                let inString = false
                let escaped = false
                let objEnd = -1

                for (let i = objStart; i < buffer.length; i++) {
                    const char = buffer[i]

                    if (escaped) {
                        escaped = false
                        continue
                    }

                    if (char === '\\' && inString) {
                        escaped = true
                        continue
                    }

                    if (char === '"') {
                        inString = !inString
                        continue
                    }

                    if (!inString) {
                        if (char === '{') depth++
                        else if (char === '}') {
                            depth--
                            if (depth === 0) {
                                objEnd = i + 1
                                break
                            }
                        }
                    }
                }

                if (objEnd === -1) {
                    // Incomplete object, wait for more data
                    break
                }

                // Extract and parse complete object
                const jsonStr = buffer.substring(objStart, objEnd)
                try {
                    const chunk = JSON.parse(jsonStr)
                    processChunk(chunk)
                } catch (e) {
                    // Parse error, skip this segment
                    console.warn("🧠 [Gemini 3] JSON parse error, skipping segment")
                }

                searchStart = objEnd
            }

            // Keep unparsed portion in buffer
            if (searchStart > 0) {
                buffer = buffer.substring(searchStart)
            }
        }

        // Finalize
        if (onFinal) {
            const finalMsg: Message = {
                id: crypto.randomUUID(),
                role: "model",
                content: accumulatedText,
                timestamp: Date.now(),
                customData: capturedSignature ? { thoughtSignature: capturedSignature } : undefined
            }

            if (capturedTools.length > 0) {
                finalMsg.content = "" // Tool calls usually have empty content
                finalMsg.tool_calls = capturedTools.map(fc => ({
                    id: "call_" + crypto.randomUUID().substring(0, 8),
                    name: fc.name,
                    arguments: fc.args
                }))
            }

            onFinal(finalMsg)
        }
    }

    private async runStream(runner: () => Promise<void>) {
        await runner()
    }
}
