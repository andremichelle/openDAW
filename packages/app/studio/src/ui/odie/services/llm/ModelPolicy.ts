// ModelPolicy.ts

/**
 * Defines the capabilities and strictness of local models.
 * Used to prevent small models from hallucinating tool usage.
 */

export type ModelTier = "tier1" | "tier2" | "tier3"

export interface ModelValidation {
    tier: ModelTier
    label: string
    color: string
    bg: string
    allowTools: boolean
}

// import { ModelCapabilities } from "./OllamaCapabilityService"

// checkModelTier signature updated to silence unused var lints
export const checkModelTier = (
    modelId: string
): ModelValidation => {
    // OPERATION UNSHACKLE:
    // The user requested to remove all "random rules" and limitations.
    // We trust the user. If they selected a model, they want it to act as an Agent.
    // No more checking parameters. No more whitelists.

    console.log("🔓 Operation Unshackle: Granting Tier 1 Access to", modelId)

    return {
        tier: "tier1",
        label: "🔓 Unrestricted Agent",
        color: "#c084fc", // Premium color
        bg: "#581c87",
        allowTools: true
    }
}
