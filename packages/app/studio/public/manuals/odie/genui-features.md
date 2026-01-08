---
title: GenUI Features
category: AI Co-Pilot
tags: ["AI", "GenUI", "Widgets"]
desc: Generative UI components available in Odie.
---

# 🎨 Generative UI (GenUI) Features

> **Goal**: Visualize data instantly.
> **Tech**: React Widget Injection

Sometimes text isn't enough. When you ask about complex data, Odie renders **Native Widgets** directly in the chat stream. These aren't images—they are real, interactive application components.

---

## 📘 1. Concepts: Dynamic Rendering

Odie's Brain detects when a visual aid is superior to a text description.
*   **Comparison**: If you compare two things, it renders a **Table**.
*   **Parameter**: If you ask to set a value, it renders a **Knob**.
*   **Music**: If you ask for a scale, it renders a **MIDI Grid**.

### The "Magic" Behind the Knobs
Odie does not send "pictures" of knobs. It sends **Code Specifications**.
When you say "Compare Synths", Odie constructs a pure JSON Data Payload describing the table. The OpenDAW engine then builds the Native React Components instantly.

**Why is this better?**
*   **Zero Loading Time**: No images to download.
*   **Interactive**: You can actually click and drag the knobs.
*   **Pixel Perfect**: It always aligns with your current Theme.


---

## 📖 2. Reference: The Widget Library

### 📊 Comparison Table
**Trigger**: "Compare [A] vs [B]"
**Use Case**: deciding between plugins, microphones, or techniques.
**Feature**: Side-by-side specs with clear headers.

### 🎛️ Smart Knob
**Trigger**: "Set [Parameter] to [Value]"
**Use Case**: Visualizing changes to gain, tempo, or plugin settings.
**Feature**: Interactive Dial (Visual feedback only in current version).

### 🎹 MIDI Grid
**Trigger**: "Show me [Scale/Chord]"
**Use Case**: Learning music theory visualization.
**Feature**: Piano-roll style display of notes and duration.

### 🖼️ Image Gallery
**Trigger**: "Generate an image of..."
**Use Case**: Creating Album Art or Mood Boards.
**Feature**: Powered by Google Gemini Vision. Renders high-quality illustration.

---

## 💪 3. Task: Generating Album Art

Odie can act as your personal graphic designer.

1.  Open the Chat.
2.  Type: *"Generate a futuristic album cover with neon cyberpunk colors."*
3.  **Wait**: Image generation takes 3-5 seconds.
4.  **Result**: A high-res image appears in the chat.
5.  **Action**: Right-click the image to **Save As**.

**Pro Tip**: You can refine the image.
> *"Make it darker and add a robot."*
Odie will use the previous context to regenerate the variant.
