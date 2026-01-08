---
title: Command Reference
category: AI Co-Pilot
tags: ["AI", "Commands", "Slash"]
desc: Complete list of Odie slash commands.
---

# ⌨️ Command Reference Matrix

> **Goal**: A Dictionary of "Magic Words" that trigger verified actions.

While Odie understands natural language, specific phrasing ensures 100% execution accuracy.

---

## 📘 1. Concepts: Slash vs. Natural

### Slash Commands (`/`)
These bypass the LLM reasoning entirely. They are **hardcoded** execution paths for system utilities. Use these for debugging or instant state checks.
*   *Speed*: Instant (<10ms).
*   *Intelligence*: Zero.

### Natural Language
These are sent to the LLM. The AI reasons about your intent and calls the appropriate tool.
*   *Speed*: Variable (500ms - 2s).
*   *Intelligence*: High (Context Aware).

---

## 📖 2. Reference: The Cheat Sheet

### A. Slash Utilities
These are safe, verified utilities for managing your session.

| Command | Function | Use Case |
| :--- | :--- | :--- |
| `/clear` | Wipes Chat History | Start fresh if Odie gets confused. |
| `/list` | List Tracks | See exactly what the AI sees in the track list. |
| `/samples` | List Samples | Browse the indexed sample library. |
| `/help` | User Manual | View the full command guide. |

> **Developer Note**: Advanced debugging tools (`/debug`, `/verify3ui`, `/keys`) are hidden under the `/dev` command.


### B. App Control Triggers

| Domain | Natural Trigger | Example |
| :--- | :--- | :--- |
| **Workflow** | `Add [Type] Track` | "Add a Drums track", "Add a Return track" |
| **Workflow** | `Delete [Target]` | "Delete this track", "Remove selected region" |
| **Transport** | `Play` / `Stop` / `Record` | "Hit it", "Cut", "Start recording" |
| **Transport** | `Set BPM to [Value]` | "Tempo 128", "Make it faster" |
| **Editing** | `Split` | "Split selection here", "Cut the clip" |
| **Editing** | `Quantize` | "Quantize to 1/16", "Fix the timing" |
| **Plugins** | `Add [Effect]` | "Add Reverb", "Put a Compressor on this" |

### C. GenUI Triggers

| Widget | Trigger Phrasing |
| :--- | :--- |
| **Table** | "Compare [A] vs [B]" |
| **Knob** | "Set [Param] to [Value]" |
| **Grid** | "Show me a [Scale/Chord]" |
| **Image** | "Generate an image of [Subject]" |

---

## 💪 3. Task: Chaining Commands

Odie's Brain (Gemini Pro) is capable of **Multi-Step Reasoning**. You can chain commands in a single sentence.

**The Prompt**:
> *"Add a bass track, name it 'Sub', and load a compressor."*

**The Execution Flow**:
1.  `addTrack("audio", "Sub")` -> **Wait** -> Track Created.
2.  `insertPlugin("compressor")` -> **Wait** -> Plugin Loaded.
3.  **Reply**: *"Created 'Sub' track with Compressor."*

**Pro Tip**: Keep chains to 3 steps max to minimize latency/timeout risks.
