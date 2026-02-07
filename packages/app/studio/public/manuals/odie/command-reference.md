---
title: Command Reference
category: AI Co-Pilot
tags: ["AI", "Commands", "Slash"]
desc: Complete list of Odie slash commands.
---

# ⌨️ Alpha Command Reference

> **Status**: Alpha Readiness Audit
> **Goal**: Dictionary of hardcoded commands that bypass AI reasoning for 100% execution accuracy.

While Odie understands natural language, slash commands (`/`) are direct system calls. Use them for instant utility or debugging.

---

## 📘 1. Concepts: Direct vs. Reasoning

### Slash Commands (`/`)
Hardcoded execution paths.
*   *Speed*: Instant (<10ms).
*   *Intelligence*: Zero.
*   *Reliability*: 100%.

### Natural Language
Sent to the LLM (Gemini 3) for reasoning.
*   *Speed*: Variable (500ms - 2s).
*   *Intelligence*: High (Context Aware).
*   *Reliability*: 95% (Probability based).

---

## 📖 2. Reference: Utilities

### A. Transport & Project
| Command | Function | Example |
| :--- | :--- | :--- |
| `/play` | Start engine | `/play` |
| `/stop` | Stop engine | `/stop` |
| `/record` | Start recording | `/record` (Immediate) or `/record true` (Count-in) |
| `/new` | New empty project | `/new` |

### B. Tracks & Assets
| Command | Function | Example |
| :--- | :--- | :--- |
| `/add [type]` | Add specific track | `/add audio "Vocal"`, `/add drums` |
| `/list` | Show current tracks | `/list` |
| `/samples` | Browse indexed samples | `/samples` |
| `/soundfonts` | Browse instruments | `/soundfonts` |

### C. Plugin Control
Directly load effects without LLM delay.
| Command | Function | Example |
| :--- | :--- | :--- |
| `/effect [track] [effect]` | Add Audio Effect | `/effect Bass Reverb` |
| `/meff [track] [effect]` | Add MIDI Effect | `/meff Keys Arpeggiator` |
| `/set-nano [track] [query]` | Load Sampler | `/set-nano Drums 808_Kick` |
| `/set-sf [track] [query]` | Load Soundfont | `/set-sf Lead Piano` |

---

## 🛠️ 3. Developer & Support

Hidden or advanced tools for system maintenance.

| Command | Function |
| :--- | :--- |
| `/help` | Display this guide in chat. |
| `/clear` | Wipe current chat history for a fresh state. |
| `/keys` | Check status and health of your API Key library. |
| `/dev` | List all hidden developer tools. |
| `/debug` | Dump system state to browser console for inspection. |
| `/diagnose` | (WIP) Trigger a deep nervous system check. |
| `/purge` | **Factory Reset**: Clear all keys, history, and settings (Deletes LocalStorage). |

---

## 💪 4. Best Practices: Chaining

Odie's Reasoning Engine (Gemini 3) can handle **Multi-Step Tasks**. You can chain commands in a single prompt.

**Standard Command**:
> *"Add a synth track called 'Pad', set the volume to -6dB, and load a Chorus."*

**Alpha Tip**: If a multi-step prompt fails, break it down or use specific slash commands (e.g., `/add synth Pad`) for the critical steps.

