---
title: Troubleshooting
category: AI Co-Pilot
tags: ["AI", "Help", "Debug"]
desc: Common issues and how to fix them.
---

# 🔧 Alpha Troubleshooting

> **Status**: Alpha Readiness Audit
> **Goal**: Self-diagnose and fix common issues in the Alpha environment.

Odie includes built-in visual indicators and diagnostic commands to help you identify connectivity or logic issues.

---

## 📘 1. Concepts: The Status Bar

Located at the bottom of the Odie panel, the status bar provides real-time health checks of your "Nervous System" (the connection between the UI, the LLM, and the Studio Engine).

### Status Indicators
| Color | Pulse | Meaning | Fix |
| :--- | :--- | :--- | :--- |
| **Gray** | Yes | `checking` | Initializing provider... wait 2-3s. |
| **Green** | No | `ready` | System operational. |
| **Red** | No | `disconnected` | API Key invalid or Network lost. |
| **Purple** | Yes | `thinking` | LLM is generating a response. |

---

## 📖 2. Reference: Common Error Matrix

### Connectivity Issues
| Symptom | Probable Cause | Fix |
| :--- | :--- | :--- |
| **"No API"** | Missing Key | Open Settings (Gear icon) and paste your Google Gemini key. |
| **"Error" in Status** | Invalid Key | Re-validate your key in Settings. |
| **Stuck on "Thinking"** | Quota Limit | Free tiers have strict rate limits. **Fix**: Add 2-3 extra keys in Settings. |
| **"Nervous System Disconnected"** | Engine Sync Lost | Refresh the browser or use `/new` to reset state. |

### Tool Execution (Alpha Context)
| Symptom | Probable Cause | Fix |
| :--- | :--- | :--- |
| **"I cannot do that yet"** | Missing Tool | The Alpha may not support every DAW operation yet. Try simpler commands. |
| **"Selection Required"** | Logic Guard | You must have a clip or track selected for this operation. |
| **Widget won't update** | GenUI Lag | Use `/verify-ui` to force a redraw test. |

---

## 💪 3. Task: Running Diagnostics

If Odie is behaving unexpectedly, run these three checks in order:

### Step 1: Network & Keys
1.  Type `/keys`.
2.  Ensure you have at least one key marked with a green checkmark (`✓ READY`).
    *   **Pro-Tip**: Having **3+ keys** in your KeyRing ensures a smooth, uninterrupted session.

### Step 2: System Health
1.  Type `/debug`.
2.  Open your browser's Developer Console (`F12` or `Cmd+Option+I`).
3.  Inspect the "Odie Debug Dump" to see raw engine state.

### Step 3: Hard Reset
1.  If all else fails, type `/purge`.
2.  **Warning**: This will wipe your keys, name, and history. It is a factory reset for the Alpha.
3.  Refresh your browser after the purge completes.
