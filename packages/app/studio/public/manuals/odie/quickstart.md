---
title: Quickstart Guide
category: AI Co-Pilot
tags: ["AI", "Odie", "Setup"]
desc: Get up and running with Odie in 5 minutes.
---

# ⚡ Alpha Quickstart: Get Up and Running

> **Status**: Alpha Readiness Audit
> **Goal**: Issue your first verified command in under 60 seconds.
> **Prerequisites**: OpenDAW Studio (Alpha)

---

## 📘 1. Concepts: The "Sidecar" UI

Odie lives in a collapsable **Sidecar Panel** on the right side of the screen.
This ensures it never blocks your timeline or mixer view. You can toggle it via the **Robot Icon** in the workspace header.

---

## 💪 2. Task: Activation & Setup

### Step 1: Wake It Up
1.  Click the **Robot Icon** in the studio header.
2.  The sidebar will slide out.

### Step 2: Connect the Brain (Initial Setup)
Odie requires a connection to an AI model to function. In the Alpha, you must provide your own API key.

1.  Click the **Gear Icon** (Settings) in the Odie sidebar rail.
2.  **Provider**: Choose **GEMINI API** (Recommended) or **LOCAL**.
3.  **API Key**: Paste your key (Google Gemini keys are stored securely in your browser's `localStorage`).
    *   **Pro-Tip**: You can add **multiple keys** here to multiply your rate limits. Odie will automatically rotate them for you.
4.  **Verify**: Click **Test Connection**. Look for the **Green Status Dot** at the bottom of the panel.

### Step 3: Define Your Identity
Help Odie personalize its music production advice.

1.  Click the **Profile Icon** in the Odie sidebar rail.
2.  Set your **Name** and a brief description of your musical style.
3.  Odie uses this to tailor technical suggestions to your specific workflow.

### Step 4: The "Hello World"
Let's verify the reasoning engine.
1.  Type: `Hello` and press **Enter**.
2.  **Success**: The status bar will pulse purple (`thinking`) and Odie will reply.
3.  **Failure**: If the status dot turns red (`disconnected`), check your API Key in Settings.

---

## 💪 3. Task: Your First Action

Let's do something real.

1.  Ensure the studio engine is running.
2.  Type: `Add a vintage synth track`
3.  **Watch the status bar**:
    *   `thinking` -> Odie is reasoning about the command.
    *   `ready` -> The command is sent to the Studio Engine.
    *   **Result**: A new track appears in the sequencer and Odie confirms the action.

---

## 📖 4. Reference: Navigation Rail

| Icon | Function |
| :--- | :--- |
| **Profile** | Configure your artist identity. |
| **Sparkles** | Clear context and start a **New Chat**. |
| **History** | Browse and restore previous conversations. |
| **Settings** | Manage API Keys and Provider settings. |

[Next: Command Reference](./command-reference.md)
