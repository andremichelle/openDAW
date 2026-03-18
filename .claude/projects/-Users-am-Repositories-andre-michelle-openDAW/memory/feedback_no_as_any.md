---
name: Never use 'as any'
description: User strongly prohibits using 'as any' type casts - always use proper types instead
type: feedback
---

Never use `as any` in this codebase. Always define proper types. If a value needs a type that doesn't exist yet, add the field to the type definition (e.g., `id?: int` on UserOutput) rather than casting with `as any`.

**Why:** The user considers `as any` a serious code quality violation. It bypasses the type system entirely and defeats the purpose of using TypeScript.

**How to apply:** When you need to access a property that isn't on the current type, extend the type to include it. Never cast to `any` as a shortcut.
