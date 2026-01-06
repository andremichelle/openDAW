---
title: Quickstart Guide
category: AI Co-Pilot
tags: ["AI", "Odie", "Setup"]
desc: Get up and running with Odie in 5 minutes.
---

# ⚡ Quickstart: Zero to Production

> **Goal**: Issue your first verified command in under 60 seconds.
> **Prerequisites**: OpenDAW Studio (v2.0+)

---

## 📘 1. Concepts: The "Sidecar" UI

Odie lives in a collapsable **Sidecar Panel** on the right side of the screen.
This ensures it never blocks your timeline or mixer view. You can toggle it via the **Robot Icon** <img style="width:16px;vertical-align:middle" src="/icons/odie-logo.png" /> in the main header.

---

## 💪 2. Task: Activation & Setup

### Step 1: Wake It Up
1.  Click the **Robot Icon** in the top-left header.
2.  The sidebar will slide out.
3.  **Status Check**: You should see the message: *"I am listening."*

### Step 2: Connect the Brain (API Key)
Odie requires a neural backend to function.
1.  Click the **Gear Icon** (Settings) in the sidebar header.
2.  Locate the **Provider** section.
3.  Choose **Google Gemini** (Recommended) or **Custom**.
4.  Paste your API Key.
    *   *Security Note*: Keys are **securely stored** in `localStorage`. They are never sent to OpenDAW servers.

![System Configuration](../assets/odie_system_config.png)
*Fig: The System Config modal where you manage your neural backend.*

### Step 3: Define Your Sound
Before you start, tell Odie who you are.

1.  Click your **Avatar/Profile Icon**.
2.  Fill out the **Artist Passport** (Identity, Sonic Profile).
3.  This helps Odie customize its personality (e.g. "Mentor" vs "Co-Pilot").

![Artist Passport](../assets/odie_artist_passport.png)
*Fig: The Artist Passport allows you to define your core identity and sonic preferences.*

### Step 4: The "Hello World"
Let's verify the connection.
1.  Type: `Hello` and press **Enter**.
2.  **Success**: Odie replies "I am ready to help."
3.  **Failure**: If you see a spinner or red error, check your API Key.

---

## 💪 3. Task: Your First Action

Let's do something real.

1.  Ensure you are in the **Tracks View**.
2.  Type: `Add a vintage synth track`
3.  **Watch closely**:
    *   Odie will display: *"Processing..."*
    *   A new track labeled "Vintage Synth" will appear in the sequencer.
    *   An instrument plugin will load automatically.
    *   Odie will reply: *"Created 'Vintage Synth' track."*

Congratulations. You just performed a **Verified App Control** action.

---

## 📖 4. Reference: Interaction Modes

| Mode | Icon | How to Use |
| :--- | :--- | :--- |
| **Text** | ⌨️ | Default. Type naturally. Shift+Enter for new lines. |
| **Slash** | `/` | Power user commands (e.g., `/clear`, `/verify`). |

[Next: The Chat Interface](./03-chat-interface.md)
