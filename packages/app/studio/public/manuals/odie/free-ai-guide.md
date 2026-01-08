---
title: Free AI Guide
category: AI Co-Pilot
tags: ["AI", "Free", "Models"]
desc: Using Odie with free LLM providers.
---

# 💸 The "Free AI" Guide: Infinite Intelligence

> **Goal**: Run Odie 24/7 without paying a cent.
> **Strategy**: The "Round Robin" Multi-Key System.

Odie is designed to be accessible to everyone. By leveraging the generous free tiers of modern AI providers, you can build a system that essentially never sleeps and never charges you.

---

## 📘 1. The Strategy: "Round Robin" Pooling

Most AI providers (like Google Gemini) offer a **Free Tier**.
*   **The Catch**: They limit how many messages you can send per minute (Rate Limit).
*   **The Hack**: Odie allows you to add **multiple API keys**.

### How It Works
Imagine you have 5 keys.
1.  You send a message -> **Key #1** works.
2.  You send another -> **Key #2** works.
3.  ...
4.  By the time you get back to **Key #1**, its "cooldown timer" has reset.

**Result**: You effective multiply your free limit by 5x, 10x, or more.

---

## 💪 2. Task: Setting Up The Pool

1.  **Generate Keys**: Go to [Google AI Studio](https://aistudio.google.com/) and create multiple keys (or use different Google accounts).
2.  **Open Settings**: Click the **Gear Icon** in Odie.
3.  **Add Keys**:
    *   Paste Key #1 -> Click "Add".
    *   Paste Key #2 -> Click "Add".
    *   Repeat.
4.  **Verify**: Type `/keys` in the chat to see your "Battery Health".

### The "Auto-Failover" Engine
If a key hits a limit (Error 429), Odie **instantly** switches to the next healthy key in the millisecond before you even notice. You don't have to manually swap them. It just works.

---

## 🔒 3. Privacy & Cost

*   **Zero Cost**: As long as you stay within the free tier of each key, you pay $0.
*   **Local Storage**: Your keys are **stored locally** in your browser (`localStorage`). They are **never** sent to OpenDAW servers or anyone else. You own the keys.

> [!TIP]
> **Recommended**: add at least **3 keys** for a smooth, uninterrupted "Flow State" experience.
