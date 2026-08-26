# Custom Parameter Mapping for Werkstatt & Spielwerk

## Goal

Enable `@param` declarations to specify value mapping (linear, exp, int, bool), range, default in mapped space, and optional unit. Parameters are displayed with their mapped values and units on the knobs, and `paramChanged` delivers the mapped value to user code.

---

## @param Format

```
// @param <name> [default] [min max type [unit]]
```

### Parsing Rules

| Format | Interpretation |
|---|---|
| `// @param gain` | unipolar 0–1, default 0 |
| `// @param gain 0.5` | unipolar 0–1, default 0.5 |
| `// @param bypass true` | bool, default 1 (true) |
| `// @param bypass false` | bool, default 0 (false) |
| `// @param bypass bool` | bool, default 0 (false) |
| `// @param bypass true bool` | bool, default 1 (true), redundant type allowed |
| `// @param cutoff 1000 20 20000 exp` | exponential 20–20000, default 1000 |
| `// @param cutoff 1000 20 20000 exp Hz` | same with unit "Hz" |
| `// @param mode 0 0 3 int` | integer 0–3, default 0 |
| `// @param time 500 1 2000 linear ms` | linear 1–2000, default 500, unit "ms" |

Detection logic:
1. If second token is `true` or `false` → **bool** (optional trailing `bool` keyword ignored)
2. If second token is `bool` → **bool**, default false
3. If exactly 1 token → **unipolar**, default 0
4. If exactly 2 tokens (second is numeric) → **unipolar**, default = token
5. If 5+ tokens → **mapped**: `name default min max type [unit]`
6. Anything else → **error**

### Supported Mapping Types

| Type | ValueMapping | StringMapping | paramChanged receives |
|---|---|---|---|
| `unipolar` (default) | `ValueMapping.unipolar()` | `StringMapping.percent()` | `number` (0–1) |
| `linear` | `ValueMapping.linear(min, max)` | `StringMapping.numeric({unit})` | `number` (min–max) |
| `exp` | `ValueMapping.exponential(min, max)` | `StringMapping.numeric({unit})` | `number` (min–max) |
| `int` | `ValueMapping.linearInteger(min, max)` | `StringMapping.numeric({unit, fractionDigits: 0})` | `number` (integer) |
| `bool` | `ValueMapping.linearInteger(0, 1)` | `StringMapping.values("", [0, 1], ["Off", "On"])` | `number` (0 or 1) |

Bool uses `linearInteger(0, 1)` so the type stays `number` everywhere — no signature change to `paramChanged`.

---

## Storage

### How openDAW Stores Parameter Values

openDAW stores **mapped values** in typed fields, not unitValues:
- `Float32Field` stores the actual float value (e.g., 1000.0 Hz)
- `Int32Field` stores the actual integer (e.g., 3)
- `BooleanField` stores true/false

The `ValueMapping<T>` converts between the stored value (type T) and unitValue (0–1) for knob position, automation lanes, and modulation. The field type `T` and the ValueMapping type `T` must match — a type mismatch crashes (e.g., `ValueMapping.bool` on `Float32Field` tries to store `true` in a number field).

### WerkstattParameterBox — Forge Schema Change Required

The `value` and `defaultValue` fields must change from `"unipolar"` constraint to `"any"`:

```typescript
// Before: float32 unipolar — clamps to [0, 1], cannot store mapped values
4: {type: "float32", name: "value", constraints: "unipolar", unit: "%", pointerRules: ParameterPointerRules},
5: {type: "float32", name: "defaultValue", constraints: "unipolar", unit: "%"}

// After: float32 any — stores the mapped value directly
4: {type: "float32", name: "value", constraints: "any", unit: "", pointerRules: ParameterPointerRules},
5: {type: "float32", name: "defaultValue", constraints: "any", unit: ""}
```

This is required because with `ValueMapping.linear(20, 20000)`, calling `setUnitValue(0.5)` stores `10010.0` in the field — the unipolar constraint would clamp this to `1.0`.

**Backward compatible**: existing projects have values in 0–1 range, which are valid `"any"` values. With `ValueMapping.unipolar()` (identity mapping), behavior is unchanged.

### Bool Uses linearInteger(0, 1), Not ValueMapping.bool

`ValueMapping.bool` returns `boolean`, which cannot be stored in a `Float32Field` (type mismatch crash). Instead, bool parameters use `ValueMapping.linearInteger(0, 1)`:
- Stores `0.0` or `1.0` in the Float32Field ✓
- `paramChanged` receives `0` or `1` (numbers) ✓
- Knob snaps between two positions (`floating()` returns `false`) ✓
- No new box type needed ✓

### Int Uses linearInteger(min, max)

`ValueMapping.linearInteger(min, max)` returns `int` (branded `number`), compatible with `Float32Field`. Integers are stored as floats (e.g., `3.0`). Float32 represents all integers up to 2^23 exactly — sufficient for any practical Werkstatt parameter range.

### No New Boxes Needed

A single `WerkstattParameterBox` with `Float32Field "any"` handles all mapping types:

| Mapping | Field stores | ValueMapping |
|---|---|---|
| unipolar | 0.5 | `unipolar()` |
| linear(20, 20000) | 1000.0 | `linear(20, 20000)` |
| exp(20, 20000) | 1000.0 | `exponential(20, 20000)` |
| int(0, 127) | 64.0 | `linearInteger(0, 127)` |
| bool | 0.0 or 1.0 | `linearInteger(0, 1)` |

### Mapping Metadata

The mapping info (min, max, type, unit) is **not stored in the box**. It is derived from the `@param` comment in the code string at two points:
1. **ScriptCompiler.reconcileParameters** — parses params, stores the mapped default directly in the box
2. **Adapter constructor** — parses params from the code to determine the ValueMapping for each parameter by label

The code is the single source of truth for mapping info.

---

## Changes

### 0. WerkstattParameterBox Forge Schema

Change fields 4 and 5 in `packages/studio/forge-boxes/src/schema/devices/audio-effects/WerkstattParameterBox.ts`:
- `value`: constraint `"unipolar"` → `"any"`, unit `"%"` → `""`
- `defaultValue`: constraint `"unipolar"` → `"any"`, unit `"%"` → `""`

Then regenerate the box class.

### 1. ScriptCompiler.ts — Extended Parsing

**ParamDeclaration** — extend the interface:
```typescript
interface ParamDeclaration {
    label: string
    defaultValue: number      // in mapped space (e.g., 1000 for Hz)
    min: number               // mapping range min
    max: number               // mapping range max
    mapping: "unipolar" | "linear" | "exp" | "int" | "bool"
    unit: string              // display unit (e.g., "Hz", "ms")
}
```

**parseParams** — rewrite to handle the extended format. Return the full declaration including mapping info.

**reconcileParameters** — store the mapped default value directly in the box (the field is now `"any"`, not `"unipolar"`):
```typescript
paramBox.value.setValue(declaration.defaultValue)
paramBox.defaultValue.setValue(declaration.defaultValue)
```

**New helper** — `resolveValueMapping(declaration)` returns the appropriate `ValueMapping<number>` based on the declaration's mapping type, min, and max.

**New helper** — `resolveStringMapping(declaration)` returns the appropriate `StringMapping<number>` based on the mapping type and unit.

Export both helpers so adapters can reuse them.

### 2. WerkstattDeviceBoxAdapter.ts / SpielwerkDeviceBoxAdapter.ts — Dynamic Mapping

In the `onAdded` callback, instead of hardcoding `ValueMapping.unipolar()`:
1. Parse the params from `box.code.getValue()` (using the compiler's `parseParams`)
2. Find the declaration matching the parameter's label
3. Create the appropriate `ValueMapping` and `StringMapping` from the declaration

```typescript
onAdded: ({box: parameterBox}) => {
    const paramBox = asInstanceOf(parameterBox, WerkstattParameterBox)
    const label = paramBox.label.getValue()
    const declaration = declarations.find(decl => decl.label === label)
    const valueMapping = resolveValueMapping(declaration)
    const stringMapping = resolveStringMapping(declaration)
    this.#parametric.createParameter(paramBox.value, valueMapping, stringMapping, label)
}
```

The `declarations` array is parsed once from `box.code.getValue()` and refreshed on code changes.

### 3. Processors — No Change

`WerkstattDeviceProcessor.parameterChanged` and `SpielwerkDeviceProcessor.parameterChanged` already call `parameter.getValue()`, which returns the mapped value through the `ValueMapping`. Since the adapter now sets the correct mapping, the processor automatically delivers mapped values to `paramChanged`.

### 4. Manual Pages — Update @param Documentation

Update the Werkstatt and Spielwerk manual pages to document the extended `@param` format, supported types, and examples.

### 5. Examples — Update to Use Mapped Parameters

Update the `.js` example files to use the new format where appropriate. For example:
```javascript
// @param cutoff 1000 20 20000 exp Hz
// @param resonance 0.707 0.1 10 linear
```

Instead of the current manual scaling in `paramChanged`.

---

## Backward Compatibility

- `// @param name` and `// @param name default` continue to work as unipolar (0–1)
- Existing projects with unipolar parameters load unchanged — values in 0–1 range are valid `"any"` values, and `ValueMapping.unipolar()` is identity
- Forge schema change (unipolar → any) is backward compatible: existing float32 values in [0, 1] are valid in "any" constraint

---

## Reconciliation Behavior

When the user recompiles with changed parameters:

- **Label unchanged, mapping changed** — The unitValue stays. The adapter recreates the parameter with the new ValueMapping. The processor receives a `paramChanged` call with the newly mapped value. If the default value changed, the control is reset to the new default.
- **Label unchanged, default changed** — The value is reset to the new default (converted to unitValue). The processor receives `paramChanged` with the new default.
- **Label added** — New parameter box created, value set to default. Processor receives `paramChanged`.
- **Label removed** — Parameter box deleted, knob removed.

After every recompile, all parameter values are re-pushed to the processor via `paramChanged` (the `#pushAllParameters` call in `#swapProcessor` already handles this).

---

## Validation

The compiler validates `@param` declarations and throws on:
- `default` outside `[min, max]` (with tolerance for floating-point error, e.g., `Math.abs(default - min) > 1e-6`)
- `min >= max` (with same tolerance)
- Unknown mapping type (not one of `linear`, `exp`, `int`, `bool`)
- Malformed syntax (wrong number of tokens, non-numeric values where numbers expected)
