
export interface OdieCapabilities {
    canGenUI: boolean
    canGenImages: boolean
    canReasonDeeply: boolean
}

export class OdieCapabilityService {

    private static readonly DEFAULT_CAPABILITIES: OdieCapabilities = {
        canGenUI: false,
        canGenImages: false,
        canReasonDeeply: false
    }

    // Mapping of Model IDs to Capabilities
    private static readonly CAPABILITY_MAP: Record<string, OdieCapabilities> = {
        "gemini-3-pro-preview": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "gemini-3-flash-preview": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "gemini-3-pro-image-preview": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "gemini-2.5-flash-image": { canGenUI: true, canGenImages: true, canReasonDeeply: true },

        "gemini-3": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "gemini-2": { canGenUI: true, canGenImages: true, canReasonDeeply: true },
        "-image": { canGenUI: true, canGenImages: true, canReasonDeeply: true },

        "gemini-1.5": { canGenUI: false, canGenImages: false, canReasonDeeply: true },

        "llama": { canGenUI: false, canGenImages: false, canReasonDeeply: false },
        "deepseek": { canGenUI: false, canGenImages: false, canReasonDeeply: true }
    }

    static getCapabilities(modelId: string): OdieCapabilities {
        const lowerId = modelId.toLowerCase()

        if (lowerId.includes('-image')) {
            return { canGenUI: true, canGenImages: true, canReasonDeeply: true }
        }

        for (const [key, caps] of Object.entries(this.CAPABILITY_MAP)) {
            if (lowerId.includes(key)) {
                return caps
            }
        }

        return this.DEFAULT_CAPABILITIES
    }

    /**
     * Returns the system instruction injection for the given capabilities.
     */
    static getSystemInstruction(caps: OdieCapabilities): string {
        const lines: string[] = []

        if (caps.canGenUI) {
            lines.push(`[CAPABILITY: GENERATIVE_UI]`)
            lines.push(`Use interactive widgets for structured data and comparisons:`)
            lines.push(``)
            lines.push(`Decision Matrix:`)
            lines.push(`| Context | Component |`)
            lines.push(`|---|---|`)
            lines.push(`| "Compare X and Y" | comparison_table |`)
            lines.push(`| "How do I...?" or steps | step_list |`)
            lines.push(`| Parameter/knob details | smart_knob |`)
            lines.push(`| MIDI/grid preview | midi_grid |`)
            lines.push(``)
            lines.push(`Format: Wrap widget JSON in a code block:`)
            lines.push("```json")
            lines.push(`{ "ui_component": "comparison_table", "data": { "headers": [...], "rows": [[...], [...]] } }`)
            lines.push("```")
            lines.push(``)
            lines.push(`Available Widgets:`)
            lines.push(`- comparison_table: { headers: string[], rows: string[][] }`)
            lines.push(`- smart_knob: { label: string, value: number, min: number, max: number }`)
            lines.push(`- step_list: { steps: string[] }`)
            lines.push(`- midi_grid: { notes: {pitch: number, time: number, duration: number}[] }`)
            lines.push(``)
        } else {
            lines.push(`[CAPABILITY: TEXT_ONLY]`)
            lines.push(`Text-only mode. Use standard Markdown for tables and lists. Do not use JSON widgets.`)
        }

        if (caps.canGenImages) {
            lines.push(``)
            lines.push(`[CAPABILITY: IMAGE_GENERATION]`)
            lines.push(`You can generate images directly. When the user asks for diagrams, waveform visualizations, or equipment layouts, use the 'generate_image' tool.`)
            lines.push(`Do not state that you cannot generate images.`)
        }

        return lines.join("\n")
    }
}

