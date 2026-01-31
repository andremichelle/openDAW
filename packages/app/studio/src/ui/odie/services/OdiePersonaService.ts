import { odieFocus, FocusContext } from "./OdieFocusService";
import { GENRE_DNA, ROLE_MINDSETS, UNIVERSAL_TRUTHS, APP_CAPABILITIES, CORE_IDENTITY } from "./OdieKnowledgeSeed";
import { odieMemory } from "./OdieMemoryService";
import { KNOWLEDGE_MODULES } from "../data/OdieKnowledgeBase";

import { userService } from "./UserService";

export interface OdieContext {
    project?: {
        bpm: number;
        genre?: string;
        key?: string;
        trackCount?: number;
        trackList?: string[];
        selectionSummary?: string;
        loopEnabled?: boolean;
        focusHints?: {
            selectedTrack: string | null;
            recentlyDiscussedTrack: string | null;
            hint: string;
        };
    };
    userQuery?: string;
    modelId?: string;
    providerId?: string;
    forceAgentMode?: boolean;
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
}

class OdiePersonaService {

    /**
     * Generates a professional system prompt for the AI assistant.
     */
    async generateSystemPrompt(context: OdieContext): Promise<string> {
        const parts: string[] = [];

        // 1. Core Identity
        parts.push(CORE_IDENTITY);

        parts.push("\n### Audio Engineering Principles:");
        UNIVERSAL_TRUTHS.forEach(t => parts.push(`- ${t}`));

        // 1.5 Context
        parts.push("\n### Environment:");
        parts.push("You are the assistant for OpenDAW, a professional web-based workstation.");
        parts.push("Capabilities:");
        APP_CAPABILITIES.forEach(c => parts.push(`- ${c}`));

        // 1.6 Tool Usage
        parts.push("\n### Tool Usage Guide:");
        parts.push("You have tools to control playback, tracks, and the mixer.");
        parts.push("- DO NOT use tools for simple greetings or process questions.");
        parts.push("- ONLY use tools when the user explicitly requests an action (e.g., 'Add a track', 'Press play').");
        parts.push("- If you use a tool, be concise in your response.");

        // [NATURALIZATION] Sanity Checks
        parts.push("\n### Parameter Validation:");
        parts.push("If a user requests a value that is technically impossible or likely a typo (e.g., 5000 BPM, +50dB gain), clarify before acting.");
        parts.push("If a tool fails due to a missing track name, suggest the closest match from the project track list.");

        // 1.7 Communication Style
        parts.push("\n### Communication Style:");
        parts.push("1. **Persona**: Professional Audio Engineer and Mentor.");
        parts.push("2. **Technical Depth**: Use correct industry terminology (Transients, Phase, Glue, Punch).");
        parts.push("3. **Contextual Advice**: Briefly explain the engineering reason behind your suggestions.");
        parts.push("4. **Formatting**: Use **Bold** for key values and bullet points for steps.");

        // 2. Mindsets
        parts.push("\n### Specialist Mindsets:");
        Object.values(ROLE_MINDSETS).forEach(mindset => parts.push(mindset));

        const currentFocus = odieFocus.getFocus();
        const role = this.mapFocusToRole(context, currentFocus);
        parts.push(`\n### Current Task Focus: ${role}`);

        // 2.1 User Profile
        parts.push(userService.getPromptContext());

        // 2.2 Knowledge Routing
        if (context.userQuery) {
            const q = context.userQuery.toLowerCase();
            const relevantDocs: string[] = [];

            if (q.match(/(vapor|synth|oscillator|unison|poly|nano|sub|tone|sine|test|sampler|drum|playfield|sample|kit|loop)/)) relevantDocs.push(KNOWLEDGE_MODULES.Schema);
            const fxKeywords = /(reverb|delay|echo|space|hall|plate|compressor|limiter|dynamics|crusher|bit|eq|filter|cut|boost|frequency|mix|pan|width|arp|arpeggio|pattern|chord|scale|velocity|humanize)/;
            if (q.match(fxKeywords)) relevantDocs.push(KNOWLEDGE_MODULES.SignalFlow);

            if (relevantDocs.length > 0) {
                parts.push("\n### Technical References:");
                Array.from(new Set(relevantDocs)).forEach(doc => parts.push(doc));
            }
        }

        // 2.2.5 Model Specifics
        if (context.modelId) {
            const caps = OdieCapabilityService.getCapabilities(context.modelId);
            parts.push("\n### Model-Specific Instructions:");
            parts.push(OdieCapabilityService.getSystemInstruction(caps));
        }

        // 3. Project Context
        if (context.project) {
            const genre = context.project.genre || "Electronic";
            const genreProfile = GENRE_DNA[genre] || GENRE_DNA['Electronic'];

            parts.push(`\n### Project Context (${genre}):`);
            parts.push(`- Goal: ${genreProfile.goal}`);
            parts.push("- Genre Guidelines:");
            genreProfile.rules.forEach(r => parts.push(`  - ${r}`));

            parts.push(`\n### Project State:`);
            parts.push(`- Tempo: ${context.project.bpm} BPM`);
            parts.push(`- Key: ${context.project.key || "Unknown"}`);
            parts.push(`- Loop: ${context.project.loopEnabled ? "Enabled" : "Disabled"}`);

            if (context.project.trackList?.length) {
                parts.push(`- Tracks: ${context.project.trackList.join(", ")}`);
            }
            if (context.project.selectionSummary) {
                parts.push(`- Current Selection: ${context.project.selectionSummary}`);
            }
        } else {
            parts.push(`\n### Status: No Project Loaded.`);
            parts.push("Ask the user if they want to create a new project or load an existing one.");
        }

        // 4. Memory
        const queryTags: string[] = [role, currentFocus];
        if (context.project?.genre) queryTags.push(context.project.genre);
        if (context.userQuery) queryTags.push(...context.userQuery.split(' ').filter(w => w.length > 3));

        const memories = await odieMemory.queryFacts(queryTags);
        if (memories.length > 0) {
            parts.push("\n### User Preferences (Memory):");
            memories.slice(0, 5).forEach(m => parts.push(`- ${m.content}`));
        }

        return parts.join("\n");
    }

    public mapFocusToRole(context: OdieContext, focus: FocusContext): keyof typeof ROLE_MINDSETS {
        const query = (context.userQuery || "").toLowerCase();

        if (query.includes("mix") || query.includes("balance") || query.includes("eq") || query.includes("compress")) return 'Mixer';
        if (query.includes("master") || query.includes("loudness") || query.includes("lufs")) return 'Mastering';
        if (query.includes("lyric") || query.includes("chord") || query.includes("melody") || query.includes("write")) return 'Songwriter';

        switch (focus) {
            case 'Mixer': return 'Mixer';
            default: return 'Producer';
        }
    }

    getCognitiveProfile(role: keyof typeof ROLE_MINDSETS): { thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' } {
        switch (role) {
            case 'Songwriter': return { thinkingLevel: 'minimal' };
            case 'Producer': return { thinkingLevel: 'low' };
            case 'Mixer': return { thinkingLevel: 'medium' };
            case 'Mastering': return { thinkingLevel: 'high' };
            default: return { thinkingLevel: 'medium' };
        }
    }
}

import { OdieCapabilityService } from "./OdieCapabilityService";
export const odiePersona = new OdiePersonaService();

