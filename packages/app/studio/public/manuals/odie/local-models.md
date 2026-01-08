---
title: Local Models
category: AI Co-Pilot
tags: ["AI", "Local", "Ollama"]
desc: Running Odie with secure local models.
---

# 🧪 Power User: Local Models (Offline AI)

> **Goal**: Run Odie completely offline using your own hardware.
> **Status**: **Beta / Experimental**
> **Prerequisite**: A powerful GPU (M1/M2/M3 or RTX 3060+ recommended).

Odie supports connecting to local inference engines like **Ollama** or **LM Studio**. This gives you 100% privacy and zero reliance on cloud services.

---

## ⚠️ The Trade-Offs (Read First)

Running AI locally is a "Power User" feature. It behaves differently than the cloud version:

| Feature | Cloud (Gemini Pro) | Local (Qwen 3 Coder) |
| :--- | :--- | :--- |
| **Speed** | ⚡️ Fast (<1s) | 🐢 Variable (Depends on Model Size) |
| **Reasoning** | 🧠 Genius (Complex Logic) | ✅ Balanced (Qwen 3 Coder) |
| **App Control** | ✅ Verified | ⚠️ Experimental (May fail complex tasks) |
| **Images** | ✅ Yes | ❌ No (Coming Soon) |
| **GenUI** | ✅ Yes | ❌ No (Text Only) |

> [!IMPORTANT]
> **Finding Your Fit**: Local AI performance is dictated by your GPU and RAM. 
> - **CPU vs GPU**: Ollama automatically detects your hardware. If a model is too large for your Graphics Card (GPU), it spills over to your much slower System Memory (CPU).
> - **Audio Stability**: For music production, **VRAM is the "Gold Standard"**. Running AI on your CPU consumes the same processing power used for your audio plugins and synth engines.
> - **The Test**: Run `ollama ps` in your terminal. If it says **100% CPU**, your audio is at risk of glitches (pops/clicks). Aim for a smaller version that shows **100% GPU** to keep your CPU dedicated to your "Sound".
> - **The Trade-off**: Running local is slower and less precise than the Cloud, but offers 100% privacy. This is a "Power User" feature not suitable for all machines.

---

## 💪 Task: Setting Up Ollama

1.  **Download Ollama**: Get it at [ollama.com](https://ollama.com).
2. **Pull a Model**: Run `ollama run qwen3-coder` in your terminal (or specify size, e.g., `qwen3-coder:32b`).
3. **Configure Odie**:
    *   Open **Settings** (Gear Icon).
    *   Set Provider to **Custom / Local**.
    *   Base URL: `http://localhost:11434/v1`
    *   Model ID: `qwen3-coder` (or your chosen size)

---

## 🔮 Roadmap: The Future of Local
We are actively working to bring parity to local models.
*   **Next Update**: Better support for "Function Calling" (reliably adding tracks).
*   **Future**: Local Stable Diffusion for image generation.
