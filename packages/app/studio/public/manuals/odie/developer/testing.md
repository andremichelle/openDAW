---
title: Testing & Benchmarks
category: Developer Guide
tags: ["Dev", "QA", "Test"]
desc: Testing protocols for the AI system.
---

# 🧪 Testing & QA Protocols

> **Package**: `@app/studio/ui/odie`
> **Role**: Quality Assurance & Regression Testing
> **Last Audit**: 2026-01-05

AI codebases are non-deterministic by nature. To ensure Odie doesn't regress into hallucination, we employ a **Testing Pyramid**, ranging from static type checks to high-level visual simulations.

---

## 📘 1. Concepts & Architecture

### The Verification Pyramid

1.  **Static Analysis (TypeScript)**: Ensures `OdieToolDefinitions` match the Zod schemas.
2.  **Unit Logic (Code)**: Tests `OdieAppControl` methods in isolation.
3.  **Visual Simulation (/verify3ui)**: Deterministic injection of UI payloads to verify rendering.

---

## 📖 2. Reference: The Test Suite

### A. The `/verify` Suite (Integration)
**Trigger**: User types `/verify` in chat.
**Mechanism**:
1.  **Connectivity Check**: Pings `AppKnowledge` to ensure the Observer is active.
2.  **Write Check**: Attempts a safe, invisible write (e.g., toggling a silent flag).
3.  **Latency Check**: Measures round-trip time to the Event Bus.

### B. The `/verify3ui` Suite (Rendering)
**Trigger**: User types `/verify3ui` in chat.
**Mechanism**:
Bypasses the LLM entirely. Injects hardcoded, complex JSON payloads into the `OdieRenderEngine` to prove that Widgets are rendering correctly.
**Coverage**:
*   Comparison Tables (CSS alignment).
*   Smart Knobs (Rotation logic).
*   MIDI Grids (Canvas rendering).

---

## 💪 3. Task: Running a Regression Test

### Scenario: You modified `OdieAppControl.ts`
You changed how tracks are added. You need to verify you didn't break the AI.

### Step 1: Live Verification
1.  Launch OpenDAW.
2.  Open Odie.
3.  Type: `/verify`
4.  **Expected Output**: "System Green. Write Latency: 12ms."

### Step 2: Visual Simulation
1.  Type: `/verify3ui`
2.  **Expected Output**: A chat stream filled with diverse widgets (Table, Knob, List).
3.  **Action**: Scroll through and visually verify nothing is broken or misaligned.
