---
title: GenUI Features
category: AI Co-Pilot
tags: ["AI", "GenUI", "Widgets"]
desc: Generative UI components available in Odie.
---

# 🎨 Alpha GenUI & Reasoning

> **Status**: Alpha Readiness Audit
> **Goal**: Documentation for generative components and the reasoning engine.

In this Alpha version, Odie transitions from a simple chat bot to a **Reasoning Co-Pilot**. It doesn't just process text; it "thinks" through DAW workflows and renders interactive visual components (GenUI).

---

## 🧠 1. Concepts: The Reasoning Engine

Powered by **Gemini 3**, Odie now includes a "Thinking" phase before every response.

### Thinking Levels
| Level | Complexity | Use Case |
| :--- | :--- | :--- |
| **Minimal** | Fast, direct. | Simple transport commands (`/play`). |
| **Medium** | Balanced reasoning. | Multi-step DAW operations (Adding tracks + Plugins). |
| **High** | Deep analysis. | Technical troubleshooting or complex musical theory. |

> [!NOTE]
> **Molecular Knowledge**: Odie is grounded in the "OpenDAW Bible"—a molecular knowledge base of every instrument, effect, and internal system. This ensures the reasoning phase uses valid parameters and verified DAW nomenclatures.

---

## 🎛️ 2. Reference: GenUI Widgets

When a visual tool is more efficient than text, Odie injects a **Native Widget** directly into the chat stream.

### 📊 Comparison Table
**Trigger**: "Compare [Plugin A] vs [Plugin B]"
**Usage**: Side-by-side technical specs for effects or instruments.

### 🎛️ Live Knob
**Trigger**: "Show me the Gain setting" or "Set Tempo"
**Usage**: Provides a touch-screen friendly dial for precise parameter control.

### 🎹 MIDI Grid
**Trigger**: "Show me the C-Major scale"
**Usage**: Visualizes note patterns and rhythms before they are committed to the timeline.

---

## 🖼️ 3. Task: Vision & Visuals

Odie can generate technical schematics or educational diagrams to help you understand complex audio concepts.

1.  **Request**: *"Generate a schematic of how a Compressor works."*
2.  **Thinking**: Odie first "Director Reasons" the visual structure.
3.  **Generation**: The Gemini 3 Vision model renders the high-fidelity schematic.
4.  **Action**: You can right-click any generated image to **Save As** or **Copy**.

---

## 🛠️ 4. Alpha Verification (GenUI)

If widgets aren't appearing or seem stuck:
1.  Type `/verify-ui`.
2.  This forces the engine to render a "System Diagnostics" test widget.
3.  If the test widget appears, the GenUI bridge is healthy.
