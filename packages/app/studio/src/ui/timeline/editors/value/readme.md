# ValueEditor

The `ValueEditor` is a reusable component for editing automation events. It supports two distinct use cases:

1. **Parameter Automation** - Events stored in normalized space (0-1)
2. **Tempo Automation** - Events stored in actual BPM space

## eventMapping

The `eventMapping: ValueMapping<number>` parameter bridges the gap between how events are stored and how they are
displayed on the Y-axis.

### How it works

```
Storage Space  <--eventMapping-->  Display Space
(event.value)                      (Y-axis pixels)
```

- `eventMapping.x(value)` - Converts from storage space to normalized (0-1) for pixel calculation
- `eventMapping.y(normalized)` - Converts from normalized (0-1) to storage space

### Parameter Automation

For parameters, events are stored in normalized space (0-1). The `eventMapping` is an identity mapping:

```typescript
eventMapping = {ValueMapping.unipolar()}  // x(v) = v, y(v) = v
```

The Y-axis directly represents the 0-1 range.

### Tempo Automation

For tempo, events are stored in actual BPM values (30-1000). The `eventMapping` converts between BPM and normalized:

```typescript
eventMapping = {tempoValueContext.valueMapping}  // x(bpm) -> 0-1, y(0-1) -> bpm
```

The Y-axis spans the BPM range, with the mapping handling the conversion.

## Related Mappings

Note that `eventMapping` is distinct from `context.valueMapping`:

- **eventMapping** - Converts between storage space and Y-axis display
- **context.valueMapping** - Parameter-specific display conversion (e.g., 0-1 to Hz for a filter cutoff)

Both may be identity mappings, or both may perform actual conversions, depending on the use case.
