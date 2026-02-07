---
title: System Overview
category: Developer Guide
tags: ["Dev", "Arch", "Odie"]
desc: High-level architecture of the Odie system.
---

# 🏗️ Odie System Overview

> **Package**: `@app/studio/ui/odie`
> **Architecture Pattern**: Sidecar / Event-Driven Observer
> **Primary Technology**: React + MobX + Vercel AI SDK
> **Last Audit**: 2026-01-08

The **Odie AI Subsystem** is an integrated engine embedded within OpenDAW Studio. It allows users to control the Digital Audio Workstation using natural language commands, context-aware reasoning, and interactive GenUI widgets.

---

## 📘 1. Architecture Concepts

### The Sidecar Pattern
Odie is architected as a **Sidecar Application**. It runs within the same browser tab as the DAW but maintains a strict boundary separation to ensure the stability of the Audio Engine.

*   **Isolation**: Odie's state loop (`OdieService.ts`) is separate from the Studio's core logic.
*   **Safety**: If Odie crashes or handles a request incorrectly, the core Studio state remains protected.
*   **Communication**: Odie talks to the host via a verified bridge (`OdieAppControl.ts`) and reads state via an observer (`ContextService.ts`).

### Architecture Diagram
```mermaid
graph TD
    subgraph "OpenDAW Main (Host)"
        AudioEngine[Audio Engine (WASM)]
        StudioStore[Studio MobX Store]
        ReactUI[Main Interface]
    end

    subgraph "Odie Sidecar (Guest)"
        Brain[AI Service / Provider]
        OdieStore[Odie Service Store]
        ChatUI[Sidebar Interface]
        GenUI[Render Engine]
    end

    %% Read Path
    StudioStore -->|Observes Changes| Context[Context Service]
    Context -->|Injects Context| Brain

    %% Write Path (Verified)
    Brain -->|Tool Calls| Control[App Control Service]
    Control -->|Executes Actions| StudioStore

    %% Isolation
    ReactUI -.- ChatUI
```

### The State Loop
1.  **Observe**: `ContextService.ts` scans the Studio State (Track count, Tempo, Selection).
2.  **Reason**: When the user sends a message, this "State Snapshot" is injected into the context provided to the AI.
3.  **Act**: The AI determines if a tool call is needed using `OdieToolDefinitions.ts`.
4.  **Verify**: The tool executes via `OdieAppControl.ts` and updates the Studio state.

---

## 🛡️ 2. Philosophy: Native Verified Bridge

Instead of using generic model protocols, Odie uses a **Native Verified Bridge** for several critical reasons:

### 1. Safety First
*   **Strict Typing**: Our bridge is strictly defined. Odie cannot perform arbitrary file operations or destructive actions outside of its defined toolset. It can only call safe, creative methods like `addTrack()` or `setVolume()`.

### 2. Reliability
*   **In-Memory Communication**: Odie runs inside the browser memory. Communication between the AI reasoning and the DAW execution is instantaneous, avoiding networking overhead or external server dependencies for app control.

### 3. Deep Context Awareness
*   **Real-time Eyes**: By residing within the same memory space, Odie can read the entire MobX state store efficiently, providing deep context about the current mixer view, project timeline, and plugin states.

---

## 📖 3. Service Reference

The system is composed of specialized singleton services.

| Service | File | Role |
| :--- | :--- | :--- |
| **Kernel** | `OdieService.ts` | The startup bootstrapper and UI state manager (Visibility, Navigation). |
| **Brain** | `AIService.ts` | Manages LLM providers (Gemini, Ollama), history, and streaming. |
| **Hands** | `OdieAppControl.ts` | The bridge allowed to mutate Studio State based on AI tool calls. |
| **Eyes** | `ContextService.ts` | Read-only observer that serializes the DAW state into context for the AI. |
| **Canvas** | `OdieRenderEngine.tsx` | Generative UI renderer for rich interactive components. |

---

## 💪 4. Task: Bootstrapping Odie

### Startup Sequence
When OpenDAW launches, Odie initializes and connects its listeners.

1.  **User Click**: User clicks the **Robot Icon** in the header.
2.  **Mount**: `OdieSidebar.tsx` mounts the React tree.
3.  **Service Init**: `OdieService` ensures providers are ready and context is scanning.
    *   Loads `localStorage` configuration and active provider.
    *   Checks for API Keys in the KeyRing.
    *   Subscribes to DAW state changes via `ContextService`.
4.  **Ready**: The system is ready to receive the first prompt.

### Debugging the Startup
If the Odie panel fails to respond correctly:
1.  Open Bronze Browser DevTools Console.
2.  Inspect the `window.odie` object (if exported) or check service logs.
3.  Verify the connection status in the **Odie Settings** panel.
    *   **Fix**: If history or settings are corrupted, use the **Clear History** button in settings or clear `odie_config` from `localStorage`.
