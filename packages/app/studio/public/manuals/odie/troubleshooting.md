---
title: Troubleshooting
category: AI Co-Pilot
tags: ["AI", "Help", "Debug"]
desc: Common issues and how to fix them.
---

# 🔧 Troubleshooting & Support

> **Goal**: Self-diagnose and fix common issues.
> **Scope**: Connectivity, Voice, and Tool Execution.

Odie includes built-in diagnostic tools to help you identify why it might be misbehaving.

---

## 📘 1. Concepts: The Error Pipeline

Odie allows errors to "Fail Gracefully".
*   **System Errors (Red)**: Connectivity or API key issues. Odie stops working.
*   **Setup Required (Orange)**: Missing API Key or Profile. Shows the **Error Card** with a direct "Open Settings" button.
*   **Logic Errors (Yellow)**: The AI tried to do something impossible (e.g., delete a track that doesn't exist). Odie will reply with a helpful hint.

---

## 📖 2. Reference: Common Error Matrix

### Connectivity Issues

| Symptom | Probable Cause | Fix |
| :--- | :--- | :--- |
| **"Odie is not responding"** | API Key Invalid | Check Settings > Provider. Generate a new Google Gemini Key. |
| **"Setup Required" Card** | Missing Config | Click "Open Settings" and ensure both Name and API Key are set. |
| **Spinning Wheel (Forever)** | Quota Limit Reached | You may have hit the Free Tier limit. Wait 60s and retry. |
| **"Network Error"** | Offline | Check your Wi-Fi. Odie requires the internet. |



### Tool Execution Issues

| Symptom | Probable Cause | Fix |
| :--- | :--- | :--- |
| **"I cannot do that yet."** | Hallucination | The AI tried to invent a tool. Try rephrasing explicitly ("Add Audio Track"). |
| **"Selection Required"** | Context Missing | Select the region/track first, *then* send the command. |
| **Visuals don't appear** | GenUI Disabled | Ensure you are using a Provider Config that supports Vision. |

---

## 💪 3. Task: Getting Help
You don't need to leave the app to read the manual.

1.  Click the **Book Icon** ("Help") in the header.
2.  Use the **Knowledge Base** to search for commands or concepts.



## 💪 4. Task: Running Diagnostics

If you are stuck, perform a **System Self-Test**.

### Step 1: Connectivity Check
1.  Type: `Hello`
2.  If no reply, your API connection is dead. Re-enter Key.

### Step 2: The Verify Command
1.  Type: `/verify`
2.  Odie will run a script to check if it can "Touch" the Studio Engine.
3.  **Result**: Look for "Write Latency". If it says "Timeout", the App Control Verified Bridge is broken.

### Step 3: The Hard Reset
1.  Open **Settings**.
2.  Click **Clear History**.
3.  Refresh the Browser (`Cmd+R`).
4.  This wipes the short-term memory and re-syncs the context.
