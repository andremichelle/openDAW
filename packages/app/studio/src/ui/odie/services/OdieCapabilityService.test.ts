import { describe, it, expect } from 'vitest';
import { OdieCapabilityService } from "./OdieCapabilityService";

describe("OdieCapabilityService", () => {

    it("should return Full Capabilities for Gemini 3 Flash", () => {
        const caps = OdieCapabilityService.getCapabilities("gemini-3-flash");
        expect(caps.canGenUI).toBe(true);
        expect(caps.canGenImages).toBe(true);
    });

    it("should return Safe Capabilities for Ollama (Local)", () => {
        const caps = OdieCapabilityService.getCapabilities("llama-3-8b");
        expect(caps.canGenUI).toBe(false);
        expect(caps.canGenImages).toBe(false);
    });

    it("should default to Safe for unknown models", () => {
        const caps = OdieCapabilityService.getCapabilities("unknown-model-123");
        expect(caps.canGenUI).toBe(false);
    });

    it("should generate correct System Instructions for Dual Mode", () => {
        const geminiCaps = { canGenUI: true, canGenImages: true, canReasonDeeply: true };
        const geminiPrompt = OdieCapabilityService.getSystemInstruction(geminiCaps);

        expect(geminiPrompt).toContain("interactive widgets");
        expect(geminiPrompt).toContain("generate_image");

        const localCaps = { canGenUI: false, canGenImages: false, canReasonDeeply: false };
        const localPrompt = OdieCapabilityService.getSystemInstruction(localCaps);

        expect(localPrompt).toContain("Text-only mode");
        expect(localPrompt).toContain("Use standard Markdown");
        expect(localPrompt).not.toContain("interactive widgets");
    });

});
