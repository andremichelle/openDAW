---
title: Chat Interface
category: AI Co-Pilot
tags: ["AI", "UI", "Chat"]
desc: Understanding the Odie chat window and controls.
---

# 💬 The Chat Configuration

> **Goal**: Master the "Conversation" with your DAW.
> **Prerequisites**: Odie Connected (See Quickstart)

Odie's sidebar is not just a text log—it is a live monitor of your session's context.

---

## 📘 1. Concepts: Context Bubbles

When you chat with Odie, you aren't just sending text. Odie "sees" a snapshot of your current focus. This is called a **Context Bubble**.

*   **Active Selection**: If a clip is selected, "Delete" means "Delete Clip", not "Delete Track".
*   **Active Panel**: If the Mixer is open, "Make it brighter" implies EQ or Filter adjustments.
*   **Transport State**: If playing, Odie knows the BPM and Time Signature.

**Pro Tip**: Always select what you want to talk about *before* sending your message.

---

## 📖 2. Reference: The Interface Anatomy

### A. The Header
The top of the Odie panel contains system controls:
*   **History Icon 🕒**: Opens the Chat History list where you can load previous sessions.
*   **Gear Icon ⚙️**: Opens Settings (API Keys, Provider selection, and Memory clear).

### B. The Stream
The conversation log where interactions take place:
*   **Blue Bubbles**: Your commands and questions.
*   **Gray Bubbles**: Odie's replies and reasoning.
*   **Widgets**: Interactive elements (Knobs, Tables, and GenUI) appear here inline.

### C. The Input Area
The bottom section where you compose your instructions:
*   **Text Area**: Multi-line input (Shift+Enter for new lines).
*   **Attach 📎**: Upload text files (.txt, .md, .json) to provide context.
*   **Send ➤**: Executes the current command.

---

## 💡 Quick Tips
*   **Clear Chat**: Type `/clear` to wipe the current conversation stream (this keeps your settings intact).
*   **Auto-Scroll**: The chat automatically follows new messages.
*   **Esc Key**: Close the sidebar quickly using the Escape key if it is in focus.
