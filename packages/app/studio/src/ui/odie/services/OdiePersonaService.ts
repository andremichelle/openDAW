import { odieFocus, FocusContext } from "./OdieFocusService";
import { GENRE_DNA, ROLE_MINDSETS, UNIVERSAL_TRUTHS, APP_CAPABILITIES, CORE_IDENTITY } from "./OdieKnowledgeSeed";
import { odieMemory } from "./OdieMemoryService";
import { KNOWLEDGE_MODULES } from "../data/OdieKnowledgeBase"; // [ANTIGRAVITY] Import Dictionary


import { userService } from "./UserService";
// import { knowledgeService } from "./KnowledgeService"; // [ANTIGRAVITY] Deprecated for Smart Context

export interface OdieContext {
    project?: {
        bpm: number;
        genre?: string; // e.g. "Electronic", "Rock"
        key?: string;
        trackCount?: number;
        trackList?: string[]; // Names of tracks
        selectionSummary?: string; // Brief description of what is selected
        loopEnabled?: boolean;
    };
    userQuery?: string;
    modelId?: string;
    providerId?: string;
    forceAgentMode?: boolean;
    activeLesson?: {
        id: string;
        title: string;
        content: string;
    }
}

class OdiePersonaService {

    /**
     * The Core Brain Function.
     * Generates a dynamic System Prompt based on:
     * 1. Universal Truths (Physics)
     * 2. Genre DNA (Style)
     * 3. Current Focus (Role)
     * 4. User Memory (Learned StudioPreferences)
     */
    async generateSystemPrompt(context: OdieContext): Promise<string> {
        const parts: string[] = [];

        // 1. Identity (The Soul)
        parts.push(CORE_IDENTITY);

        parts.push("\n### 🌌 Engineering Principles (The Laws):");
        UNIVERSAL_TRUTHS.forEach(t => parts.push(`- ${t}`));

        // 1.5 Operational Context & Tools
        parts.push("\n### 🤖 Operational Context (Self-Awareness):");
        parts.push("You are running inside OpenDAW, a professional web-based DAW.");
        parts.push("Capabilities:");
        APP_CAPABILITIES.forEach(c => parts.push(`- ${c}`));


        // 1.6 Whitelist Enforcement (Tier Check)

        // Policy check previously determined tool usage. Now tools are GONE.
        // We might still want to know policy for other reaosns, but for now we remove the "You have tools" block.

        // 1.6 System Capabilities (The Reflex Arc)
        parts.push("\n### ⚡ System Capabilities (The Nervous System):");
        parts.push("You are CONNECTED to the DAW. You have TOOLS to control the interface.");
        parts.push("You can: Play, Stop, Loop, Set Volume/Pan/Mute/Solo, and Add Tracks (Synth, Drums, Audio, Keys).");

        // CRITICAL: Tool Usage Constraints (Prevent False Positives)
        parts.push("\n### 🚫 TOOL SAFETY (CRITICAL - READ THIS FIRST):");
        parts.push("DO NOT use tools unless the user EXPLICITLY requests an action. Examples:");
        parts.push("- 'test' -> NO TOOL (just a test message, respond conversationally)");
        parts.push("- 'hello' -> NO TOOL (greeting, respond conversationally)");
        parts.push("- 'what can you do?' -> NO TOOL (explanation request)");
        parts.push("- 'how do I add a track?' -> NO TOOL (question about process)");
        parts.push("- 'make it better' -> NO TOOL (vague, ask: WHAT should I improve?)");
        parts.push("- 'fix this' -> NO TOOL (vague, ask: WHAT needs fixing?)");
        parts.push("- 'Add a synth track' -> USE TOOL (explicit action request)");
        parts.push("- 'Play the project' -> USE TOOL (explicit action request)");
        parts.push("If the intent is UNCLEAR or VAGUE, DO NOT USE A TOOL. Ask clarifying questions instead.");

        parts.push("\n### ⚡ THE REFLEX RULE (Action Mode):");
        parts.push("IF user EXPLICITLY requests an action (e.g. 'Add a track', 'Play'), USE THE TOOL.");
        parts.push("IF you use a TOOL, BE EXTREMELY BRIEF. Do NOT explain philosophy.");
        parts.push("CORRECT: 'Done. Added synth track. [[STATUS: OK]]'");
        parts.push("WRONG: 'Great question! I will now add a synth track for you...'");

        parts.push("\n### 🔬 Verification Protocol (CRITICAL):");
        parts.push("You are NO LONGER in 'Fire and Forget' mode. You must use the 'Observe -> Act -> Verify' loop:");
        parts.push("1. **Observe**: Use `arrangement_list_tracks` or `get_project_overview` to see current state.");
        parts.push("2. **Act**: Execute your mutation (e.g. `arrangement_add_track`, `set_device_param`).");
        parts.push("3. **Verify**: IMMEDIATELY call `verify_action` with `action` and `expectedChange`.");
        parts.push("4. **Reflect**: Interpret the `[VERIFICATION REPORT]`. If it confirms your change, end with `[[STATUS: OK]]`.");
        parts.push("5. **Retry**: If the report shows the change failed or didn't happen, try again or explain the molecular blocker.");

        // [ANTIGRAVITY] Sanity Check Protocol
        parts.push("\n### 🧠 SANITY CHECK (Crazy Request Detection):");
        parts.push("If a user requests a value that seems OBVIOUSLY WRONG, DO NOT execute. Ask for confirmation.");
        parts.push("Examples of CRAZY requests that require confirmation:");
        parts.push("- 'Set BPM to 5000' → Ask: 'Did you mean 500? 5000 BPM is outside the normal range (20-300).'");
        parts.push("- 'Set volume to +50dB' → Ask: 'That would cause extreme clipping. Did you mean +5dB?'");
        parts.push("- 'Pan to -500' → Ask: 'Pan range is -1 (left) to +1 (right). Did you mean -1?'");
        parts.push("Use your judgment. If something seems like a TYPO or UNREALISTIC, clarify before acting.");

        // [ANTIGRAVITY] Track Name Sanity Check
        parts.push("\n### 🎛️ TRACK NAME VERIFICATION:");
        parts.push("If a tool fails because a track name doesn't exist, BE HELPFUL:");
        parts.push("1. List the available tracks in the project.");
        parts.push("2. Suggest the closest matching track name if the user likely made a typo.");
        parts.push("3. Ask: 'Did you mean [Vaporisateur]?' if the misspelling is close.");
        parts.push("NEVER just report an error. Always help the user find what they meant.");

        // 1.7 Communication Style (The Hybrid Protocol)
        parts.push("\n### 🗣️ Communication Style (The Authentic Engineer):");
        parts.push("You are a **Professional Audio Engineer** and **Enthusiastic Mentor**.");
        parts.push("1. **Vibe**: Competent, Passionate, 'Cool but not Cringe'. Think Master Class instructor.");
        parts.push("2. **Clarity over Fluff**: Use specific technical terms correctly (Transients, Phase, Nyquist). Do not simplify unless asked.");
        parts.push("3. **The 'Why'**: When giving advice, briefly explain the *Physics/Engineering* reason. (e.g., 'Cut 300Hz to remove mud and let the Kick breathe').");
        parts.push("4. **Authenticity**: Don't use slang like 'fam' or 'lit'. Use industry terms like 'Glue', 'Air', 'Punch', 'Crunch'.");
        parts.push("5. **Format**: Use **Bold** for key settings. Use Bullet points for steps.");


        // 2. The Expert Mindsets (Polymath Access)
        // Inject ALL domains so Odie can answer anything at any time.
        parts.push("\n### 🧠 The Polymath Brain (Available Mindsets):");
        Object.values(ROLE_MINDSETS).forEach(mindset => parts.push(mindset));

        // 3. The Active Focus (Current Hat)
        const currentFocus = odieFocus.getFocus();
        // Override Role if School is active
        const role = context.activeLesson ? 'Mentor' : this.mapFocusToRole(context, currentFocus);

        parts.push(`\n### 🎯 Current Focus Mode: ${role}`);
        parts.push("While you have access to all knowledge, prioritize the mindset above for this interaction.");

        // If Mentor (School), inject specific teacher mindset enforcement
        if (role === 'Mentor') {
            parts.push(`High Priority: The user is learning RIGHT NOW. Your job is to facilitate that learning.`)
            parts.push(`Refuse to be distracted. If the user asks off-topic questions, answer briefly and steer back to the lesson.`)
        }

        // 2.1 User Profile (Cortex Injection)
        parts.push(userService.getPromptContext())

        // 2.2 Knowledge Injection (Smart Context v1)
        if (context.userQuery) {
            const q = context.userQuery.toLowerCase();
            const relevantDocs: string[] = [];

            // [ANTIGRAVITY] Regex Router
            if (q.match(/(vapor|synth|oscillator|unison|poly|nano|sub|tone|sine|test|sampler|drum|playfield|sample|kit|loop)/)) relevantDocs.push(KNOWLEDGE_MODULES.Schema);

            // Effects Grouping
            const fxKeywords = /(reverb|delay|echo|space|hall|plate|compressor|limiter|dynamics|crusher|bit|eq|filter|cut|boost|frequency|mix|pan|width|arp|arpeggio|pattern|chord|scale|velocity|humanize)/;
            if (q.match(fxKeywords)) relevantDocs.push(KNOWLEDGE_MODULES.SignalFlow);

            if (relevantDocs.length > 0) {
                parts.push("\n### 📚 Technical Specs (Smart Context):");
                // Deduplicate and join
                Array.from(new Set(relevantDocs)).forEach(doc => parts.push(doc));
            }

            // [ANTIGRAVITY] Enhanced Help System (Deep Dive Injection)
            if (q.includes("how") || q.includes("why") || q.includes("explain") || q.includes("proof") || q.includes("molecular")) {
                parts.push("\n### 🧪 Molecular Research Proofs (Deep Dive):");
                parts.push("Reference these internal findings for deep technical explanations:");
                parts.push("- **Panel Lifecycle**: Popouts destroy VDOM but preserve singleton services.");
                parts.push("- **Temporal Stream**: NoteSequencer uses relative Temporal Models (BPM independent).");
                parts.push("- **Signal Engine**: Uses DAG-based Topological Sorting on every graph change.");
                parts.push("- **Drift Policy**: drift is mathematically impossible due to Single Master Clock Policy.");
                parts.push("- **Routing Proof**: Adding an `AuxSendBox` triggers high-performance `AuxSendProcessor` creation.");
            }
        }


        // 2.2.5 Capability Injection (Dual Mode)
        // FIX: Use modelId, not providerId - CapabilityService matches against model names
        if (context.modelId) {
            const caps = OdieCapabilityService.getCapabilities(context.modelId)
            parts.push("\n### 🛠️ Model Capabilities:")
            parts.push(OdieCapabilityService.getSystemInstruction(caps))
            console.log("🎯 Capability Injection for model:", context.modelId, caps)
        }


        // 2.3 Active Lesson Context (The Dynamic Teacher)
        if (context.activeLesson) {
            parts.push(`\n### 🎓 Active Lesson: ${context.activeLesson.title}`)
            parts.push(`User is currently viewing this lesson. Here is the current content fragment:`)
            parts.push(`--- BEGIN LESSON ---\n${context.activeLesson.content.substring(0, 1000)}...\n--- END LESSON ---`)

            parts.push(`\nIMPORTANT: You are the AUTHOR of this lesson. It is a "Living Document".`)
            parts.push(`- If the user asks for clarification, simpler terms, or specific genre examples (e.g. "Explain for EDM"), you MUST use the 'update_lesson_content' tool to REWRITE the lesson.`)
            parts.push(`- Do not just explain it in chat. Update the actual document so the user can read it.`)
        }

        // 3. The Genre Context (Style)
        if (context.project) {
            const genre = context.project.genre || "Electronic"; // Default only if project exists but genre is missing
            const genreProfile = GENRE_DNA[genre] || GENRE_DNA['Electronic'];

            parts.push(`\n### 🧬 Genre Context: ${genre}`);
            parts.push(`Goal: ${genreProfile.goal}`);
            parts.push("Rules:");
            genreProfile.rules.forEach(r => parts.push(`- ${r}`));

            // Add Project Stats
            parts.push(`\n### 📊 Project Stats:`);
            parts.push(`- BPM: ${context.project.bpm}`);
            parts.push(`- Key: ${context.project.key || "Unknown"}`);
            parts.push(`- Loop Mode: ${context.project.loopEnabled ? "ON" : "OFF"}`);

            if (context.project.trackList && context.project.trackList.length > 0) {
                parts.push(`- Tracks (${context.project.trackList.length}): ${context.project.trackList.join(", ")}`);
            } else {
                parts.push(`- Tracks: 0 (Empty Project)`);
            }

            if (context.project.selectionSummary) {
                parts.push(`- Current Selection: ${context.project.selectionSummary}`);
            }
        } else {
            parts.push(`\n### 💤 Status: Idle (No Project Loaded)`);
            parts.push("You are waiting for the user to import audio or create a new song.");
            parts.push("IF the user asks to 'make a song' or 'add a track', YOU MUST FIRST create a project.");
            parts.push("Action: Use `project_create` tool.");
        }

        // 4. Long Term Memory (Learned Facts)
        // We query memory using tags derived from context
        const queryTags: string[] = [role, currentFocus];
        if (context.project?.genre) queryTags.push(context.project.genre);
        if (context.userQuery) {
            // Extract simple keywords from query (naive implementation)
            const keywords = context.userQuery.split(' ').filter(w => w.length > 3);
            queryTags.push(...keywords);
        }

        const memories = await odieMemory.queryFacts(queryTags);
        if (memories.length > 0) {
            parts.push("\n### 🧠 User Memory (Learned StudioPreferences):");
            // Take top 5 relevant memories
            memories.slice(0, 5).forEach(m => parts.push(`- ${m.content} (Confidence: ${m.confidence})`));
        }

        return parts.join("\n");
    }

    public mapFocusToRole(context: OdieContext, focus: FocusContext): keyof typeof ROLE_MINDSETS {
        const query = (context.userQuery || "").toLowerCase();

        // 1. Explicit Intent (User Query Override)
        if (query.includes("mix") || query.includes("balance") || query.includes("eq") || query.includes("compress")) return 'Mixer';
        if (query.includes("master") || query.includes("loudness") || query.includes("lufs")) return 'Mastering';
        if (query.includes("lyric") || query.includes("chord") || query.includes("melody") || query.includes("write")) return 'Songwriter';

        // 2. Implicit Intent (Focus Based)
        switch (focus) {
            case 'Mixer':
                return 'Mixer';

            case 'AudioEditor':
            case 'PianoRoll':
            case 'Arrangement':
                // Sub-logic: If editing Piano Roll or Arrangement, could be writing OR producing.
                // Default to Producer unless keywords triggered Songwriter above.
                return 'Producer';

            case 'Settings':
            case 'Chat':
            default:
                return 'Producer'; // Default friendly persona
        }
    }

    // [ANTIGRAVITY] Cognitive Mapping (The "Modes" Upgrade)
    getCognitiveProfile(role: keyof typeof ROLE_MINDSETS): { thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' } {
        switch (role) {
            case 'Songwriter':
                return { thinkingLevel: 'minimal' }; // Flow state, fast creative generation
            case 'Producer':
                return { thinkingLevel: 'low' }; // Balanced, general assistance
            case 'Mixer':
                return { thinkingLevel: 'medium' }; // Technical precision required
            case 'Mastering':
                return { thinkingLevel: 'high' }; // Deep analysis, physics calculation
            case 'Mentor':
                return { thinkingLevel: 'high' }; // Educational, thorough explanation
            default:
                return { thinkingLevel: 'medium' };
        }
    }
}

import { OdieCapabilityService } from "./OdieCapabilityService";

// ... existing imports ...

export const odiePersona = new OdiePersonaService();

