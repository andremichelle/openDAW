---
title: GenUI Engine
category: Developer Guide
tags: ["Dev", "UI", "React"]
desc: Technical deep dive into the GenUI rendering system.
---

# 🎨 GenUI Engine (OdieRenderEngine)

> **Package**: `@app/studio/ui/odie`
> **Role**: Streaming Parsers & Component Factory
> **Technology**: React VDOM + Regex Parsing
> **Last Audit**: 2025-12-21

The **GenUI Engine** enables Odie to escape the text box. It intercepts specific JSON blocks in the LLM stream and hot-swaps them for native React components. This allows for interactive "Widgets" like comparison tables, smart knobs, and MIDI grids.

---

## 📘 1. Concepts & Architecture

### The "Hijack" Renderer
Standard chat interfaces render Markdown. Odie renders a hybrid stream.
The `OdieRenderEngine.tsx` component iterates through the message text. If it detects a "Code Block" that matches the Widget Signal Signature, it **suppresses the text display** and instead mounts a React Component.

### Dual-Schema Support (Audit 2025-12-21)
To support both legacy prompts and optimized V2 prompts, the engine accepts two JSON shapes.

#### 1. The Legacy Schema (Verbose)
*   **Origin**: Original Gemini 1.0 Prompts.
*   **Format**:
    ```json
    {
      "type": "ui_component",
      "component": "smart_knob",
      "data": { ... }
    }
    ```

#### 2. The V2 Schema (Optimized)
*   **Origin**: Gemini 1.5 Flash Optimization.
*   **Format**:
    ```json
    {
      "ui_component": "smart_knob",
      "data": { ... }
    }
    ```

---

## 📖 2. Widget API Reference

The following components are registered in the Factory.

| internal_id | alias_map | props interface |
| :--- | :--- | :--- |
| `comparison_table` | `table` | `{ headers: string[], rows: string[][] }` |
| `smart_knob` | `knob` | `{ label: string, value: number, min: number, max: number }` |
| `step_list` | `list`, `steps` | `{ steps: string[] }` |
| `midi_grid` | `midi` | `{ notes: Array<{ pitch: number, time: number }> }` |
| `image_gallery` | `image` | `{ url: string, prompt: string }` |

### JSON Payload Examples

#### Smart Knob
```json
{
  "ui_component": "smart_knob",
  "data": {
    "label": "Threshold",
    "value": -12.5,
    "min": -60,
    "max": 0,
    "param": "comp_threshold"
  }
}
```

#### Comparison Table
```json
{
  "ui_component": "comparison_table",
  "data": {
    "headers": ["Algorithm", "CPU Usage", "Latency"],
    "rows": [
      ["FFT-Fast", "Low", "12ms"],
      ["FFT-Precise", "High", "48ms"]
    ]
  }
}
```

---

## 💪 3. Task: Creating a New Widget

### Step 1: Create the Component
Add your minimal React component to `OdieRenderEngine.tsx` (or a separate file).

```tsx
const ColorPicker = ({ data }: WidgetProps<{ color: string }>) => {
    return (
        <div style={{ background: data.color, padding: 10 }}>
            Selected: {data.color}
        </div>
    )
}
```

### Step 2: Register in Switch
Update the `render()` function in `OdieRenderEngine`.

```typescript
render(payload: OdieWidgetPayload) {
    switch (payload.component) {
        // ... existing widgets
        case "color_picker": return <ColorPicker data={payload.data} />
    }
}
```

### Step 3: Add Alias (Optional)
If you expect the LLM to get the name wrong, map it in `parseFragments`.

```typescript
const aliasMap = {
    "color": "color_picker",
    "picker": "color_picker"
}
```

### Step 4: Verify
Type `/verify3ui` to force-render the library and check if your new widget appears correctly.
