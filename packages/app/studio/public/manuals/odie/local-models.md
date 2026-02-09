---
title: Local Models
category: AI Co-Pilot
tags: ["AI", "Local", "Ollama"]
desc: Running Odie with secure local models.
---

# 🧪 Power User: Local Models (Offline AI)

> **Goal**: Run Odie completely offline using your own hardware.
> **Status**: **Alpha Readiness (Advanced)**
> **Prerequisite**: A powerful GPU (M1/M2/M3 or RTX 3060+ recommended).

Odie supports connecting to local inference engines like **Ollama**. This gives you 100% privacy and zero reliance on cloud services.

---

## ⚠️ The Trade-Offs (Read First)

Running AI locally is a power-user feature. It behaves differently than the cloud version:

| Feature | Cloud (Gemini 3) | Local (Qwen 2.5 Coder) |
| :--- | :--- | :--- |
| **Speed** | ⚡️ Ultra-Fast (<0.5s) | 🐢 Variable (VRAM Dependent) |
| **Reasoning** | 🧠 Advanced (Thinking Mode) | ✅ Balanced (7b/32b models) |
| **App Control** | ✅ Native (High Precision) | ⚠️ Experimental (Basic Only) |
| **Vision/Files** | ✅ Deep Integration | ❌ Limited (Text Only) |
| **Molecular Knowledge** | ✅ Full Access | 🧪 Experimental |

> [!IMPORTANT]
> **Finding Your Fit**: Performance is dictated by your GPU VRAM. 
> - **CPU vs GPU**: Ollama automatically detects your hardware. If a model is too large for your Graphics Card VRAM (GPU), it spills over to your System Memory (CPU).
> - **Audio Stability**: For music production, **VRAM is the critical benchmark**. Running AI on your CPU consumes the same processing power used for your audio plugins and synth engines.
> - **The Test**: Use the **Hardware Fit** button in Settings. If it says **100% CPU**, your audio is at risk of glitches. Aim for a smaller model (e.g., `7b` or `q4_k_m` quantization) that fits entirely on your GPU.

---

## 💪 Task: Setting Up Ollama

1.  **Download Ollama**: Get it at [ollama.com](https://ollama.com).
2.  **Pull a Model**: Run `ollama run qwen2.5-coder` in your terminal.
3.  **Configure Odie**:
    *   Open **Settings** (Gear Icon).
    *   Toggle the provider switch to **LOCAL**.
    *   **Endpoint URL**: The default `/api/ollama` is recommended (it proxies to your local Ollama automatically).
    *   **Model ID**: Ensure it matches what you pulled (e.g., `qwen2.5-coder`).
    *   Click **Test Connection**.

---

## 🔮 Roadmap: The Future of Local
We are working to bring full feature parity to local models.
*   **Next Update**: Robust support for Tool Calling (reliable track/effect management).
*   **Future**: Vision support and Molecular Knowledge local grounding.
