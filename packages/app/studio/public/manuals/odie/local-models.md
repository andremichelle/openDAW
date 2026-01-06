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

| Feature | Cloud (Gemini Pro) | Local (Llama 3 / Deepseek) |
| :--- | :--- | :--- |
| **Speed** | ⚡️ Fast (<1s) | 🐢 Slow (Depends on GPU) |
| **Reasoning** | 🧠 Genius (Complex Logic) | 😐 Decent (Basic Logic) |
| **App Control** | ✅ Verified | ⚠️ Experimental (May fail complex tasks) |
| **Images** | ✅ Yes | ❌ No (Coming Soon) |
| **GenUI** | ✅ Yes | ❌ No (Text Only) |

> [!WARNING]
> Local models may struggle with complex DAW commands. For the best "Co-Pilot" experience, we currently recommend the Cloud API.

---

## 💪 Task: Setting Up Ollama

1.  **Download Ollama**: Get it at [ollama.com](https://ollama.com).
2.  **Pull a Model**: Run `ollama run llama3` in your terminal.
3.  **Configure Odie**:
    *   Open **Settings** (Gear Icon).
    *   Set Provider to **Custom / Local**.
    *   Base URL: `http://localhost:11434/v1` (or Odie's default proxy if configured).
    *   Model ID: `llama3`

---

## 🔮 Roadmap: The Future of Local
We are actively working to bring parity to local models.
*   **Next Update**: Better support for "Function Calling" (reliably adding tracks).
*   **Future**: Local Stable Diffusion for image generation.
