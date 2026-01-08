import { ModelTier } from "./ModelPolicy"

export interface ModelCapabilities {
    parameterSize: string // e.g. "32B", "7B"
    quantization: string // e.g. "Q4_K_M"
    family: string // e.g. "qwen2", "llama3"
    contextWindow: number // e.g. 32768
    suggestedTier: ModelTier
}

export class OllamaCapabilityService {

    /**
     * Checks currently loaded models and their hardware utilization.
     */
    async getHardwareStatus(baseUrl: string): Promise<any[]> {
        try {
            let root = baseUrl
            if (root.includes("/v1")) root = root.replace(/\/v1\/?$/, "")
            if (root.includes("/api/chat")) root = root.replace(/\/api\/chat$/, "")
            if (root.endsWith("/")) root = root.slice(0, -1)

            const url = `${root}/api/ps`
            const response = await fetch(url)
            if (!response.ok) return []

            const data = await response.json()
            return data.models || []
        } catch (e) {
            console.error("🔍 Hardware Status Error", e)
            return []
        }
    }

    /**
     * Inspects a model via Ollama's /api/show endpoint.
     * Returns capabilities or defaults if inspection fails.
     */
    async inspect(baseUrl: string, modelName: string): Promise<ModelCapabilities | null> {
        try {
            // Clean URL
            let root = baseUrl
            if (root.includes("/v1")) root = root.replace(/\/v1\/?$/, "")
            if (root.includes("/api/chat")) root = root.replace(/\/api\/chat$/, "")
            if (root.endsWith("/")) root = root.slice(0, -1)

            const url = `${root}/api/show`
            console.log(`🔍 OllamaCapabilityService: Inspecting ${modelName} at ${url}`)

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: modelName })
            })

            if (!response.ok) {
                console.warn(`🔍 Inspection failed: ${response.status}`)
                return null
            }

            const data = await response.json()
            const details = data.details

            if (!details) return null

            const caps: ModelCapabilities = {
                parameterSize: details.parameter_size || "Unknown",
                quantization: details.quantization_level || "Unknown",
                family: details.family || "Unknown",
                contextWindow: data.model_info?.["llama.context_length"] || 4096, // Heuristic default
                suggestedTier: "tier3" // Default to safe
            }

            // --- TIER LOGIC (The Physics Check) ---
            caps.suggestedTier = this.calculateTier(caps, modelName)

            console.log("🔍 Model Capabilities:", caps)
            return caps

        } catch (e) {
            console.error("🔍 Inspection Error", e)
            return null
        }
    }

    private calculateTier(_caps: ModelCapabilities, _name: string): ModelTier {
        // User Mandate: Treat Local Models just like API Models.
        // We assume ANY local model the user has chosen is capable.
        // We remove all "nanny logic" that downgrades small models.
        return "tier1"
    }
}

export const ollamaInspector = new OllamaCapabilityService()
