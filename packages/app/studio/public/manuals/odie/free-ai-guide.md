---
title: Free AI Guide
category: AI Co-Pilot
tags: ["AI", "Free", "Models"]
desc: Using Odie with free LLM providers.
---

# 🦅 The "Free AI" Guide: Using External Keys

> **Goal**: Run Odie using your own API keys for Alpha Readiness.
> **Note**: Always respect the Terms of Service of your AI provider.

Odie Alpha leverages **Gemini 3** for reasoning and Molecular Knowledge. By connecting your own API keys, you can power Odie with premium features for free (within provider limits).

---

## 📘 1. Adding Your Key

Most providers (like Google Gemini) offer a free tier.

1.  **Generate Keys**: Go to [Google AI Studio](https://aistudio.google.com/) and create an API Key.
2.  **Open Settings**: Click the **Gear Icon** in Odie.
3.  **Add Key**: Paste your key and click "Add".
4.  **Verify**: Type `/status` in the chat to see your connection state.

## 🔑 2. The KeyRing (Alpha Feature)

Odie supports **KeyRing**, allowing you to add multiple API keys for the same provider.

*   **Rotation**: Odie automatically rotates through your keys for each request.
*   **Rate Resilience**: This helps maintain Alpha uptime on free tiers by distributing usage.
*   **Thinking Mode**: Ensure your key has access to reasoning models for the best Alpha experience.

---

## 🔒 3. Privacy & Security

*   **Local Storage**: Your keys are **stored locally** in your browser.
*   **Zero Leakage**: They are **never** sent to external servers or logged. 
*   **Artist Passport**: Your keys are tied to your local session, ensuring your data stays yours.

