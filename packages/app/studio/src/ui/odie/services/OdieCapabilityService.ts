

export interface OdieCapabilities {
    canGenUI: boolean
    canGenImages: boolean
    canReasonDeeply: boolean
}

export class OdieCapabilityService {

    // Default to "Safe" (Local-compatible)
    private static readonly DEFAULT_CAPABILITIES: OdieCapabilities = {
        canGenUI: false,
        canGenImages: false,
        canReasonDeeply: false
    }

    // Mapping of Model IDs to Capabilities
    // CRITICAL: Only image-specific models can generate images
    // NOTE: Uses substring matching - patterns match if modelId.includes(pattern)
    private static readonly CAPABILITY_MAP: Record<string, OdieCapabilities> = {
        // [ANTIGRAVITY] Auto-Pilot Models
        "gemini-3-pro-preview": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "gemini-3-flash-preview": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "gemini-3-pro-image-preview": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "gemini-2.5-flash-image": { canGenUI: true, canGenImages: true, canReasonDeeply: true },

        // Patterns for robustness (if config is stale)
        "gemini-3": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "gemini-2": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "-image": { canGenUI: true, canGenImages: true, canReasonDeeply: true },

        // Legacy/Fallbacks
        "gemini-1.5": { canGenUI: false, canGenImages: false, canReasonDeeply: true },

        // Local
        "llama": { canGenUI: false, canGenImages: false, canReasonDeeply: false },
        "deepseek": { canGenUI: false, canGenImages: false, canReasonDeeply: true }
    }

    static getCapabilities(modelId: string): OdieCapabilities {
        const lowerId = modelId.toLowerCase()

        // CRITICAL: Check for image models FIRST (before generic patterns)
        // This ensures 'gemini-2.5-flash-image' gets image capabilities
        if (lowerId.includes('-image')) {
            return { canGenUI: true, canGenImages: true, canReasonDeeply: true }
        }

        // Then check other patterns
        for (const [key, caps] of Object.entries(this.CAPABILITY_MAP)) {
            if (lowerId.includes(key)) {
                console.log(`🎯 Capability Match: ${modelId} matched pattern '${key}'`, caps)
                return caps
            }
        }

        console.warn(`⚠️ No capability match for model: ${modelId}, using defaults`)
        return this.DEFAULT_CAPABILITIES
    }

    /**
     * Returns the "System Prompt Injection" for the given capabilities.
     * CRITICAL: This tells the AI HOW and WHEN to use each capability.
     */
    static getSystemInstruction(caps: OdieCapabilities): string {
        const lines: string[] = []

        if (caps.canGenUI) {
            lines.push(`[CAPABILITY: GENERATIVE_UI]`)
            lines.push(`You MUST use interactive widgets for these scenarios:`)
            lines.push(``)
            lines.push(`DECISION MATRIX (MANDATORY):`)
            lines.push(`| User Says... | You MUST Output... |`)
            lines.push(`| "Compare X and Y" or "X vs Y" | comparison_table widget |`)
            lines.push(`| "How do I...?" or steps/tutorial | step_list widget |`)
            lines.push(`| Parameter/knob question | smart_knob widget |`)
            lines.push(`| MIDI/notes/pattern preview | midi_grid widget |`)
            lines.push(`| Simple question (what is, explain) | Text only (NO widget) |`)
            lines.push(``)
            lines.push(`FORMAT: Wrap widget JSON in code block:`)
            lines.push("```json")
            lines.push(`{ "ui_component": "comparison_table", "data": { "headers": [...], "rows": [[...], [...]] } }`)
            lines.push("```")
            lines.push(``)
            lines.push(`EXAMPLE - User: "Compare Serum and Vital"`)
            lines.push(`Your response MUST include:`)
            lines.push("```json")
            lines.push(`{"ui_component":"comparison_table","data":{"headers":["Plugin","Price","CPU"],"rows":[["Serum","$189","High"],["Vital","Free","Medium"]]}}`)
            lines.push("```")
            lines.push(`Then briefly explain the comparison.`)
            lines.push(``)
            lines.push(`WIDGETS AVAILABLE:`)
            lines.push(`- comparison_table: { headers: string[], rows: string[][] }`)
            lines.push(`- smart_knob: { label: string, value: number, min: number, max: number }`)
            lines.push(`- step_list: { steps: string[] }`)
            lines.push(`- midi_grid: { notes: {pitch: number, time: number, duration: number}[] }`)
            lines.push(``)
            lines.push(`CRITICAL: If user request matches Decision Matrix, YOU MUST output widget JSON. Do NOT describe it in text.`)
        } else {
            lines.push(`[CAPABILITY: TEXT_ONLY]`)
            lines.push(`You are in Text-Only mode. Do NOT generate JSON widgets. Use Markdown tables for comparisons.`)
        }

        // Always tell Gemini models they can generate images (we auto-route to image model)
        if (caps.canGenImages) {
            lines.push(``)
            lines.push(`[CAPABILITY: IMAGE_GENERATION]`)
            lines.push(`You CAN generate images natively (alias: generate_image). When user asks for visual/diagram/infographic:`)
            lines.push(`- Generate the image directly in your response`)
            lines.push(`- The system will auto-route your request to an image-capable model`)
            lines.push(`- Good for: signal flow diagrams, waveform visualizations, equipment layouts, infographics`)
            lines.push(`DO NOT say "I cannot generate images" - YOU CAN. Just generate them.`)
        }

        return lines.join("\n")
    }
}

