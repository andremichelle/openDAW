# Copy and Paste Implementation Plan

> **Status**: Core infrastructure IMPLEMENTED. See individual plans for specific clipboard handlers:
> - `copy-and-paste-regions.md` - Region copy/paste (IMPLEMENTED)
> - `copy-and-paste-audiounits.md` - AudioUnit copy/paste (PLANNED)

## Summary

This plan introduces a new `resource?: "external" | "internal"` property to `BoxSchema` to enable clean copy/paste functionality for any items in the studio. Resource boxes act as endpoints/boundaries during dependency collection, preventing over-collection while still using `alwaysFollowMandatory: true`.

## Problem Statement

### Current Situation
When copying boxes (AudioUnits, Regions, etc.), the dependency collection algorithm in `BoxGraph.dependenciesOf()` must decide how far to traverse the graph:

1. **With `alwaysFollowMandatory: false`**: Prevents over-collection but may miss exclusive dependencies
2. **With `alwaysFollowMandatory: true`**: Collects all dependencies but pulls in unwanted connected boxes

### Example Problem
When copying an `AudioRegionBox`:
```
AudioRegionBox → AudioFileBox (mandatory) → TransientMarkerBox (incoming)
                      ↑
OtherRegionBox ───────┘ (also points to same AudioFileBox)
```

With `alwaysFollowMandatory: true`, the algorithm would also collect `OtherRegionBox` because it has a mandatory pointer to `AudioFileBox`. This is not desired.

### Solution: `resource` Property
Mark certain boxes as resources in their schema. Resources are endpoints/leaf nodes in the dependency graph. When collecting dependencies, stop traversal at resource boxes.

**Two types of resources:**

| Type | Description | UUID on Copy |
|------|-------------|--------------|
| `"external"` | References something outside the project (files, etc.) | Keep original |
| `"internal"` | Project-internal shared resource | Generate new |

Both types are always copied (one box instance cannot exist in multiple BoxGraphs), but the UUID handling differs. External resources keep their UUID because they reference the same external entity (e.g., same audio file). Internal resources get new UUIDs because they represent new instances within the project.

This allows:
- Using `alwaysFollowMandatory: true` for complete dependency collection
- Stopping at resource boundaries to prevent over-collection
- Proper handling of external references vs internal resources

## Analysis of Current Implementation

### BoxSchema Structure (`lib-box-forge/src/schema.ts:35-39`)
```typescript
export type BoxSchema<E extends PointerTypes> = Referencable<E> & {
    type: "box"
    class: ClassSchema<E>
    ephemeral?: boolean
}
```

### Dependency Collection (`lib/box/src/graph.ts:270-306`)
```typescript
dependenciesOf(box: Box, options: {
    excludeBox?: Predicate<Box>
    alwaysFollowMandatory?: boolean
} = {}): Dependencies {
    // ...
    const trace = (box: Box): void => {
        if (boxes.has(box) || excludeBox(box)) {return}
        boxes.add(box)
        box.outgoingEdges()
            .filter(([pointer]) => !pointers.has(pointer))
            .forEach(([source, targetAddress]: [PointerField, Address]) => {
                const targetVertex = this.findVertex(targetAddress).unwrap(...)
                pointers.add(source)
                if (targetVertex.pointerRules.mandatory &&
                    (alwaysFollowMandatory || targetVertex.pointerHub.incoming()
                        .filter(p => p.targetAddress.mapOr(...))
                        .every(pointer => pointers.has(pointer)))) {
                    return trace(targetVertex.box)
                }
            })
        box.incomingEdges()
            .forEach(pointer => {
                pointers.add(pointer)
                if (pointer.mandatory) {
                    trace(pointer.box)
                }
            })
    }
    // ...
}
```

### Resource Boxes to Mark

| Box | File | Resource Type | Reason |
|-----|------|---------------|--------|
| `AudioFileBox` | `std/AudioFileBox.ts` | `"external"` | References external audio file |
| `SoundfontFileBox` | `std/SoundfontFileBox.ts` | `"external"` | References external soundfont file |
| `GrooveShuffleBox` | `GrooveShuffleBox.ts` | `"internal"` | Project-level shared resource (prevents pulling in RootBox) |

### Critical Issue: Resource Children (TransientMarkerBox)

Resource boxes like `AudioFileBox` can have "children" - boxes that point to fields within them. These children MUST be included when copying the resource.

**Example structure:**
```
AudioRegionBox ──(file)──────────────> AudioFileBox         (points to BOX)
                                            ↑
OtherAudioRegionBox ──(file)────────────────┘               (points to BOX)

TransientMarkerBox ──(owner)──> AudioFileBox.transientMarkers  (points to FIELD)
```

**The problem:**
- Both `AudioRegionBox` and `TransientMarkerBox` create incoming edges to `AudioFileBox`
- If we simply stop traversal at resources, we miss `TransientMarkerBox` (BAD)
- But we correctly skip `OtherAudioRegionBox` (GOOD)

**The solution - differentiate by target address:**
- `AudioRegionBox.file` → points to `AudioFileBox` itself → `address.isBox() === true` → **"user"**
- `TransientMarkerBox.owner` → points to `AudioFileBox.transientMarkers` → `address.isBox() === false` → **"child"**

When we reach a resource box:
1. **STOP** following incoming edges that point to the **box itself** (other users of the resource)
2. **CONTINUE** following incoming edges that point to **fields within the box** (children/owned boxes)

## Implementation Plan

### Phase 1: Schema Changes

#### 1.1 Update BoxSchema Type (`lib-box-forge/src/schema.ts`)

Add `resource` property to `BoxSchema`:
```typescript
export type ResourceType = "external" | "internal"

export type BoxSchema<E extends PointerTypes> = Referencable<E> & {
    type: "box"
    class: ClassSchema<E>
    ephemeral?: boolean
    resource?: ResourceType  // NEW: marks box as a resource endpoint
}
```

#### 1.2 Update Box Generation (`lib-box-forge/src/forge.ts`)

Modify the code generator to include `Resource` in generated box classes:
- Add static `Resource` property to box classes (type: `ResourceType | undefined`)
- Pass through from schema to generated code

In `#writeBoxClasses` method around line 291-310:
```typescript
declaration.addProperty({
    name: "Resource",
    type: "ResourceType | undefined",
    isStatic: true,
    isReadonly: true,
    initializer: schema.resource ? `"${schema.resource}"` : "undefined"
})
```

#### 1.3 Update Box Base Class (`lib/box/src/box.ts`)

Add method/property to check resource type:
```typescript
// In Box class or as interface
get resource(): ResourceType | undefined
```

### Phase 2: Mark Resource Boxes

#### 2.1 Update AudioFileBox Schema (`forge-boxes/src/schema/std/AudioFileBox.ts`)
```typescript
export const AudioFileBox: BoxSchema<Pointers> = {
    type: "box",
    class: {...},
    pointerRules: {...},
    resource: "external"  // NEW: references external audio file
}
```

#### 2.2 Update SoundfontFileBox Schema (`forge-boxes/src/schema/std/SoundfontFileBox.ts`)
```typescript
export const SoundfontFileBox: BoxSchema<Pointers> = {
    type: "box",
    class: {...},
    pointerRules: {...},
    resource: "external"  // NEW: references external soundfont file
}
```

#### 2.3 Update GrooveBox Schema (`forge-boxes/src/schema/std/GrooveBoxes.ts`)
```typescript
// In createGrooveBox factory function
pointerRules: {mandatory: true, accepts: [Pointers.Groove]},
resource: "internal"  // NEW: project-level shared resource
```

### Phase 3: Update Dependency Collection

#### 3.1 Modify `dependenciesOf` Method (`lib/box/src/graph.ts`)

Add new option and modify traversal logic to handle resources and their children:

```typescript
dependenciesOf(box: Box, options: {
    excludeBox?: Predicate<Box>
    alwaysFollowMandatory?: boolean
    stopAtResources?: boolean  // NEW
} = {}): Dependencies {
    const stopAtResources = options.stopAtResources ?? false
    const boxes = new Set<Box>()
    const pointers = new Set<PointerField>()

    const trace = (box: Box): void => {
        if (boxes.has(box) || excludeBox(box)) {return}
        boxes.add(box)

        // Handle resource boxes specially
        if (stopAtResources && isDefined(box.resource)) {
            // Resource boxes are endpoints, but we still need their "children"
            // Children = boxes that point to FIELDS within this box (not the box itself)
            box.incomingEdges()
                .forEach(pointer => {
                    pointers.add(pointer)
                    // Only follow if pointer targets a FIELD (child), not the BOX (user)
                    const targetsField = !pointer.targetAddress.unwrap().isBox()
                    if (pointer.mandatory && targetsField) {
                        trace(pointer.box)
                    }
                })
            // Don't trace outgoing edges - resources are endpoints
            return
        }

        // Normal box traversal (existing logic)
        box.outgoingEdges()
            .filter(([pointer]) => !pointers.has(pointer))
            .forEach(([source, targetAddress]: [PointerField, Address]) => {
                const targetVertex = this.findVertex(targetAddress).unwrap(...)
                pointers.add(source)
                if (targetVertex.pointerRules.mandatory &&
                    (alwaysFollowMandatory || targetVertex.pointerHub.incoming()
                        .filter(p => p.targetAddress.mapOr(...))
                        .every(pointer => pointers.has(pointer)))) {
                    return trace(targetVertex.box)
                }
            })
        box.incomingEdges()
            .forEach(pointer => {
                pointers.add(pointer)
                if (pointer.mandatory) {
                    trace(pointer.box)
                }
            })
    }

    trace(box)
    boxes.delete(box)
    return {boxes, pointers: Array.from(pointers).reverse()}
}
```

**Key insights:**

1. **Resources ARE added** to the dependency set (we need to copy them)
2. **Children are included**: Incoming edges to FIELDS (`!address.isBox()`) are followed - these are owned boxes like `TransientMarkerBox`
3. **Users are excluded**: Incoming edges to the BOX itself (`address.isBox()`) are NOT followed - these are other users like `OtherAudioRegionBox`
4. **Outgoing edges are skipped**: Resources don't have dependencies we need to follow

**Example traversal:**
```
Starting from AudioRegionBox:
1. Add AudioRegionBox
2. Follow outgoing edge to AudioFileBox (mandatory)
3. Add AudioFileBox (it's a resource)
4. Check AudioFileBox incoming edges:
   - TransientMarkerBox → AudioFileBox.transientMarkers (FIELD) → FOLLOW ✓
   - OtherAudioRegionBox → AudioFileBox (BOX) → SKIP ✗
5. Add TransientMarkerBox
6. Done - collected: [AudioRegionBox, AudioFileBox, TransientMarkerBox]
```

### Phase 4: Refactor ProjectUtils

#### 4.1 Special Cases Analysis

**ELIMINATED** (no more `instanceof` or class name checks):
| Current Code | Refactored |
|--------------|------------|
| `alwaysFollowMandatory: false` + explicit instrument adding | `alwaysFollowMandatory: true` + `stopAtResources: true` |
| `name === AudioFileBox.ClassName \|\| name === SoundfontFileBox.ClassName` | `box.resource === "external"` |
| `instanceof AudioFileBox \|\| instanceof SoundfontFileBox` | `isDefined(box.resource)` |
| `instanceof TransientMarkerBox` + owner UUID check | Automatic (skip if external resource already exists) |

**REMAINS** (acceptable domain logic, passed via `excludeBox` predicate):
| Special Case | Reason |
|--------------|--------|
| Filter `ephemeral` boxes (SelectionBox) | Use `box.ephemeral` property |
| Filter `AuxSendBox` | Would pull in bus system via mandatory `target-bus` pointer |
| Filter `MIDIControllerBox` | MIDI mappings shouldn't copy; duplicates in same project would break |
| Position/index adjustments in extractRegions | Unavoidable domain logic |

#### 4.2 Refactored extractAudioUnits

```typescript
export const extractAudioUnits = (audioUnitBoxes: ReadonlyArray<AudioUnitBox>, ...): ... => {
    // Combine all exclusion predicates
    const excludeBox = (box: Box): boolean => {
        if (box.ephemeral) return true  // Skip ephemeral (SelectionBox, etc.)
        if (box.name === AuxSendBox.ClassName) return true  // Skip aux sends (would pull in bus system)
        if (options?.excludeTimeline === true && excludeTimelinePredicate(box)) return true
        return false
    }

    // Clean dependency collection - instruments included automatically!
    const dependencies = audioUnitBoxes
        .flatMap(box => Array.from(box.graph.dependenciesOf(box, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox
        }).boxes))

    const uuidMap = generateTransferMap(audioUnitBoxes, dependencies, ...)
    copy(uuidMap, boxGraph, audioUnitBoxes, dependencies)
    // ...
}
```

#### 4.3 Refactored generateTransferMap

```typescript
const generateTransferMap = (...): SortedSet<UUID.Bytes, UUIDMapper> => {
    // ...
    ...dependencies.map(box => ({
        source: box.address.uuid,
        // Generic resource check - no class names!
        target: box.resource === "external" ? box.address.uuid : UUID.generate()
    }))
}
```

#### 4.4 Refactored copy

```typescript
const copy = (uuidMap, boxGraph, audioUnitBoxes, dependencies) => {
    // Collect existing external resource UUIDs
    const existingResourceUUIDs = UUID.newSet<UUID.Bytes>(uuid => uuid)
    dependencies.forEach((source: Box) => {
        if (source.resource === "external" && boxGraph.findBox(source.address.uuid).nonEmpty()) {
            existingResourceUUIDs.add(source.address.uuid)
        }
    })

    // Helper: check if box is owned by an existing external resource
    const isOwnedByExistingResource = (box: Box): boolean => {
        for (const [pointer, targetAddress] of box.outgoingEdges()) {
            if (pointer.mandatory && !targetAddress.isBox()) {  // Points to a FIELD
                if (existingResourceUUIDs.opt(targetAddress.uuid).nonEmpty()) {
                    return true  // Owner is existing external resource
                }
            }
        }
        return false
    }

    PointerField.decodeWith({...}, () => {
        // Copy AudioUnitBoxes...

        dependencies.forEach((source: Box) => {
            // Skip existing external resources
            if (existingResourceUUIDs.opt(source.address.uuid).nonEmpty()) {
                return
            }
            // Skip children of existing external resources (e.g., TransientMarkerBox)
            if (isOwnedByExistingResource(source)) {
                return
            }
            // Generic copy - no instanceof checks!
            if (existingResourceUUIDs.opt(source.address.uuid).nonEmpty()) {
                return  // Skip existing resources (and their children with same UUID)
            }
            // ... copy box
        })
    })
}
```

#### 4.5 Simplify extractRegions

Similar refactoring - the `excludeBox` predicate for non-selected tracks/regions remains (domain logic), but resource handling becomes generic.

### Phase 5: Implement Copy/Paste API

#### 5.1 Design Principles

- **Copy side**: Generic - collect dependencies with `stopAtResources: true`
- **Paste side**: Consumer-specific - each paste location knows where to attach and how to remap

#### 5.2 Create CopyBuffer Structure

Create new file `adapters/src/project/CopyBuffer.ts`:
```typescript
export type CopyBuffer = {
    readonly version: number
    readonly contentType: string  // "audio-unit" | "notes" | "regions" | etc.
    readonly boxes: ReadonlyArray<{
        uuid: UUID.Bytes
        name: string
        data: ArrayBuffer
        resource?: ResourceType
    }>
}

export namespace CopyBuffer {
    export const serialize = (buffer: CopyBuffer): ArrayBuffer => {...}
    export const deserialize = (data: ArrayBuffer): CopyBuffer => {...}
}
```

#### 5.3 Create Generic Copy Function

```typescript
export const copyBoxes = (
    boxes: ReadonlyArray<Box>,
    contentType: string,
    boxGraph: BoxGraph,
    options: {
        excludeTypes?: ReadonlyArray<string>  // Box class names to exclude (e.g., [AuxSendBox.ClassName])
    } = {}
): CopyBuffer => {
    const excludeTypes = new Set(options.excludeTypes ?? [])

    // Collect dependencies (includes resources and their children)
    const dependencies = boxes.flatMap(box =>
        Array.from(boxGraph.dependenciesOf(box, {
            alwaysFollowMandatory: true,
            stopAtResources: true,
            excludeBox: box => excludeTypes.has(box.name)  // Apply exclusion at collection time
        }).boxes))

    // All boxes to copy: main boxes + dependencies
    const allBoxes = [...boxes, ...dependencies]

    // Deduplicate by UUID
    const seen = new Set<string>()
    const uniqueBoxes = allBoxes.filter(box => {
        const key = UUID.toString(box.address.uuid)
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })

    return {
        version: 1,
        contentType,
        boxes: uniqueBoxes.map(box => ({
            uuid: box.address.uuid,
            name: box.name,
            data: box.toArrayBuffer(),
            resource: box.resource
        }))
    }
}

// Usage examples:
copyBoxes(audioUnitBoxes, "audio-unit", boxGraph, {
    excludeTypes: [AuxSendBox.ClassName, MIDIControllerBox.ClassName]
})

copyBoxes(effectBoxes, "audio-effect", boxGraph, {
    excludeTypes: [MIDIControllerBox.ClassName]  // MIDI mappings shouldn't copy
})
```

#### 5.4 Paste is Consumer-Specific

Each paste location implements its own logic:

```typescript
// Example: Paste notes into NoteEventCollectionBox
const pasteNotes = (buffer: CopyBuffer, target: NoteEventCollectionBox, graph: BoxGraph) => {
    assert(buffer.contentType === "notes", "Invalid content type")

    const uuidMap = new Map<UUID.Bytes, UUID.Bytes>()
    buffer.boxes.forEach(({uuid, name, resource}) => {
        if (name === NoteEventCollectionBox.ClassName) {
            // Shell → remap to target container
            uuidMap.set(uuid, target.address.uuid)
        } else if (resource === "external") {
            // External resources keep UUID
            uuidMap.set(uuid, uuid)
        } else {
            // Everything else gets new UUID
            uuidMap.set(uuid, UUID.generate())
        }
    })

    // Create only non-shell boxes
    createBoxesWithRemapping(
        buffer.boxes.filter(b => b.name !== NoteEventCollectionBox.ClassName),
        graph,
        uuidMap
    )
}

// Example: Paste audio unit into project
const pasteAudioUnit = (buffer: CopyBuffer, skeleton: ProjectSkeleton) => {
    assert(buffer.contentType === "audio-unit", "Invalid content type")

    const {boxGraph, mandatoryBoxes: {rootBox, primaryAudioBus}} = skeleton
    const uuidMap = new Map<UUID.Bytes, UUID.Bytes>()

    buffer.boxes.forEach(({uuid, resource}) => {
        if (resource === "external") {
            uuidMap.set(uuid, uuid)
        } else {
            uuidMap.set(uuid, UUID.generate())
        }
    })

    // Remap collection/output pointers to target project
    // ... (similar to current extractAudioUnits logic)
}
```

#### 5.5 Clipboard Implementation

Use **text/plain with base64** - works cross-browser (Chrome, Firefox, Safari).

**Format:**
```
opendaw:v1:<base64-encoded-data>
```

**Why not Web Custom Formats?**
- Chrome supports `"web "` prefix MIME types for binary data
- Firefox/Safari filter out custom MIME types from paste events
- `text/plain` works consistently across all browsers

```typescript
const PREFIX = "opendaw:v1:"

export const writeToClipboard = async (buffer: CopyBuffer): Promise<void> => {
    const binary = CopyBuffer.serialize(buffer)
    const base64 = btoa(String.fromCharCode(...new Uint8Array(binary)))
    await navigator.clipboard.writeText(`${PREFIX}${base64}`)
}

// Paste requires user gesture (Ctrl+V / Cmd+V) - use paste event listener
export const setupPasteHandler = (onPaste: (buffer: CopyBuffer) => void): void => {
    const handler = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text/plain")
        if (isDefined(text) && text.startsWith(PREFIX)) {
            const base64 = text.slice(PREFIX.length)
            const binary = atob(base64)
            const data = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
                data[i] = binary.charCodeAt(i)
            }
            const buffer = CopyBuffer.deserialize(data.buffer)
            onPaste(buffer)
        }
    }
    document.addEventListener("paste", handler)
    // Return cleanup function if needed
}
```

**Tested and working in:**
- ✅ Chrome
- ✅ Firefox
- ✅ Safari

**Trade-offs:**
- Base64 adds ~33% size overhead
- Paste requires user gesture (Ctrl+V / Cmd+V)
- Copy works with any user gesture (menu click)

### Phase 6: Testing

#### 6.1 Unit Tests for Resource Flag

Create `lib/box/src/graph.test.ts` additions:
```typescript
describe("dependenciesOf with stopAtResources", () => {
    it("should include resource boxes in dependencies", () => {
        // Create: RegionBox → ResourceBox
        // Verify ResourceBox IS in collected dependencies
    })

    it("should include children of resource boxes (field-level pointers)", () => {
        // Create: RegionBox → ResourceBox ← ChildBox (points to field)
        // Verify ChildBox IS in collected dependencies
    })

    it("should exclude users of resource boxes (box-level pointers)", () => {
        // Create: RegionBox → ResourceBox ← OtherRegionBox (points to box)
        // Verify OtherRegionBox is NOT in collected dependencies
    })

    it("should differentiate children vs users by address.isBox()", () => {
        // Create complex graph:
        //   RegionA → AudioFileBox ← TransientMarker (field pointer)
        //                  ↑
        //             RegionB (box pointer)
        // Verify: RegionA, AudioFileBox, TransientMarker collected
        // Verify: RegionB NOT collected
    })

    it("should not follow outgoing edges from resource boxes", () => {
        // Create: RegionBox → ResourceBox → SomeOtherBox
        // Verify SomeOtherBox is NOT collected (resources are endpoints)
    })

    it("should include resource box when stopAtResources is false", () => {
        // Verify backward compatibility - all boxes collected
    })
})
```

#### 6.2 Integration Tests for Copy/Paste

Extend `ProjectUtils.test.ts`:
```typescript
describe("Copy/Paste with resource types", () => {
    it("should copy AudioRegion without pulling other regions sharing AudioFileBox", () => {
        // Create: Region1 → AudioFileBox ← Region2
        // Copy Region1
        // Verify: Region1, AudioFileBox copied; Region2 NOT copied
    })

    it("should include TransientMarkers when copying AudioFileBox", () => {
        // Create: Region → AudioFileBox ← TransientMarker (points to field)
        // Copy Region
        // Verify: Region, AudioFileBox, TransientMarker ALL copied
    })

    it("should keep UUID for external resources (AudioFileBox)", () => {
        // Copy AudioRegion with AudioFileBox
        // Paste into same/different project
        // Verify AudioFileBox has same UUID
    })

    it("should generate new UUID for internal resources", () => {
        // Copy box with internal resource
        // Paste
        // Verify internal resource has NEW UUID
    })

    it("should keep TransientMarker UUID linked to AudioFileBox UUID", () => {
        // Since AudioFileBox keeps UUID (external), its children should too
        // Verify TransientMarker points to correct AudioFileBox after paste
    })

    it("should handle multiple TransientMarkers correctly", () => {
        // Create AudioFileBox with 5 TransientMarkers
        // Copy region referencing it
        // Verify all 5 markers copied with correct relationships
    })
})
```

#### 6.3 Tests for CopyBuffer Serialization

```typescript
describe("CopyBuffer", () => {
    it("should serialize and deserialize correctly", () => {...})
    it("should preserve all box data", () => {...})
    it("should preserve resource type for each box", () => {...})
})
```

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `lib-box-forge/src/schema.ts` | Modify | Add `resource?: "external" \| "internal"` to BoxSchema |
| `lib-box-forge/src/forge.ts` | Modify | Generate `Resource` static property |
| `lib/box/src/box.ts` | Modify | Add `resource` getter |
| `lib/box/src/graph.ts` | Modify | Add `stopAtResources` option to `dependenciesOf` |
| `forge-boxes/src/schema/std/AudioFileBox.ts` | Modify | Add `resource: "external"` |
| `forge-boxes/src/schema/std/SoundfontFileBox.ts` | Modify | Add `resource: "external"` |
| `adapters/src/project/TransferUtils.ts` | Modify | Refactor to use `stopAtResources` |
| `adapters/src/project/CopyBuffer.ts` | Create | CopyBuffer type + serialize/deserialize + clipboard read/write |
| `lib/box/src/graph.test.ts` | Modify | Add tests for `stopAtResources` |
| `adapters/src/project/ProjectUtils.test.ts` | Modify | Refactor tests to use new resource handling |
| `adapters/src/project/CopyBuffer.test.ts` | Create | Tests for CopyBuffer serialization |

**Consumer-specific paste functions** (not in CopyBuffer):
| Location | Paste Function | Target |
|----------|----------------|--------|
| Note editor | `pasteNotes()` | `NoteEventCollectionBox` |
| Timeline | `pasteRegions()` | `TrackBox.regions` |
| Project | `pasteAudioUnit()` | `rootBox.audioUnits` |
| Effect chain | `pasteEffects()` | `AudioUnitBox.effects` |
| Instrument slot | `pasteInstrument()` | `AudioUnitBox.input` |

## Dependency Graph of Changes

```
Phase 1: Schema & Generation
    ├── schema.ts (BoxSchema type + ResourceType)
    └── forge.ts (code generation)
            │
            ▼
Phase 2: Mark Resources
    ├── AudioFileBox.ts (resource: "external")
    └── SoundfontFileBox.ts (resource: "external")
            │
            ▼
Phase 3: Dependency Collection
    ├── box.ts (resource property)
    └── graph.ts (stopAtResources option)
            │
            ▼
Phase 4: Refactor ProjectUtils
    └── TransferUtils.ts
            │
            ▼
Phase 5: Copy/Paste API
    └── CopyBuffer.ts
            │
            ▼
Phase 6: Testing
    ├── graph.test.ts
    ├── ProjectUtils.test.ts
    └── CopyBuffer.test.ts
```

## Considerations

### Backward Compatibility
- `resource` defaults to `undefined` when not specified (not a resource)
- `stopAtResources` defaults to `false` for existing code
- Existing tests should pass without modification

### Resource Handling on Paste

| Box Type | UUID Handling | Example |
|----------|---------------|---------|
| `resource: "external"` | Keep original UUID | AudioFileBox, SoundfontFileBox |
| `resource: "internal"` | Remap to target's existing resource | GrooveBox → target project's GrooveBox |
| Regular box (no resource) | Generate new UUID | TrackBox, RegionBox, etc. |

**External resources** keep their UUID because they reference the same external entity (audio file, soundfont).

**Internal resources** are project-level singletons or shared resources. On paste, the consumer should remap pointers to the target project's existing resource rather than creating duplicates.

All other boxes (including children of external resources like `TransientMarkerBox`) get new UUIDs.

When pasting into a different project with external resources:
1. External resource box is created with same UUID (references same external file)
2. Children (e.g., TransientMarkerBox) get new UUIDs but point to the same external resource
3. If the external file doesn't exist in target environment, it needs to be handled separately

### Dependency Analysis: Common Copy Scenarios

#### Copying NoteEventBox(es)
```
NoteEventBox (new UUID)
    └── events pointer → NoteEventCollectionBox.events (mandatory: false on target)
        → STOP (shell)

Result: [NoteEventBox] only
Shell on paste: NoteEventCollectionBox (target container)
```

#### Copying AudioRegionBox
```
AudioRegionBox (new UUID)
├── regions pointer → TrackBox.regions (mandatory: false on target) → STOP (shell)
├── file pointer → AudioFileBox (mandatory: true)
│   └── AudioFileBox (EXTERNAL - keep UUID, STOP traversal)
│       └── TransientMarkerBox(es) (new UUID)
│           via: mandatory field-level pointer (child of resource)
├── events pointer → ValueEventCollectionBox (mandatory: true)
│   └── ValueEventCollectionBox (new UUID)
│       └── ValueEventBox(es) (new UUID)
│           │   via: mandatory pointer to events field
│           │
│           └── ValueEventCurveBox (new UUID) - optional
│                   via: mandatory pointer to ValueEventBox.interpolation field
└── play-mode pointer → AudioPlayModeBox (mandatory: false) → included if present

Result: [AudioRegionBox, AudioFileBox, TransientMarkerBox(es), ValueEventCollectionBox, ValueEventBox(es), ValueEventCurveBox(es)?, AudioPlayModeBox?]
Shell on paste: TrackBox.regions field
```

#### Copying AudioUnitBox
```
AudioUnitBox (new UUID)
├── collection pointer → RootBox.audio-units (mandatory: false on target) → STOP (shell)
│
├── TrackBox(es) (new UUID)
│   │   via: mandatory pointer to AudioUnitBox.tracks field
│   │
│   ├── AudioRegionBox(es) (new UUID)
│   │   │   via: mandatory pointer to TrackBox.regions field
│   │   │
│   │   ├── AudioFileBox (EXTERNAL - keep UUID, STOP traversal)
│   │   │   └── TransientMarkerBox(es) (new UUID) - field-level children
│   │   │
│   │   └── ValueEventCollectionBox (new UUID)
│   │       └── ValueEventBox(es) (new UUID)
│   │           └── ValueEventCurveBox(es) (new UUID) - optional
│   │
│   ├── NoteRegionBox(es) (new UUID)
│   │   │   via: mandatory pointer to TrackBox.regions field
│   │   │
│   │   └── NoteEventCollectionBox (new UUID)
│   │       └── NoteEventBox(es) (new UUID)
│   │
│   └── ValueRegionBox(es) (new UUID)
│       │   via: mandatory pointer to TrackBox.regions field
│       │
│       └── ValueEventCollectionBox (new UUID)
│           └── ValueEventBox(es) (new UUID)
│               └── ValueEventCurveBox(es) (new UUID) - optional
│
├── InstrumentDevice (new UUID)
│   │   via: mandatory host pointer to AudioUnitBox.input field
│   │
│   └── SoundfontFileBox? (EXTERNAL - keep UUID if present)
│
├── AudioEffectDevices (new UUID)
│       via: mandatory host pointer to AudioUnitBox.audio-effects field
│
├── MidiEffectDevices (new UUID)
│       via: mandatory host pointer to AudioUnitBox.midi-effects field
│
└── AuxSendBox(es) - EXCLUDED via excludeBox predicate (would pull in AudioBusBox)

Result: Complete AudioUnit with all tracks, regions, notes, automation, instruments, and effects
Shell on paste: RootBox.audio-units field
Exclusion: AuxSendBox passed to excludeBox predicate (would pull in entire bus system via target-bus mandatory pointer)
```

#### Copying AudioEffect (e.g., CompressorDeviceBox)
```
CompressorDeviceBox (new UUID)
├── host → AudioUnitBox.audio-effects (mandatory: false on target) → STOP (shell)
├── side-chain → AudioUnitBox/AudioBusBox (mandatory: false) → don't follow
│
├── [If automation exists on parameters]
│   └── TrackBox(es) (new UUID)
│       │   via: mandatory target pointer to parameter field (e.g., threshold)
│       │
│       ├── tracks → AudioUnitBox.tracks (mandatory: false on target) → STOP (shell)
│       │
│       └── ValueRegionBox(es) (new UUID)
│           │   via: mandatory pointer to TrackBox.regions field
│           │
│           └── ValueEventCollectionBox (new UUID)
│               └── ValueEventBox(es) (new UUID)
│                   └── ValueEventCurveBox(es) (new UUID) - optional
│
└── [MIDIControllerBox - EXCLUDED via excludeTypes]
        Would create duplicate MIDI mappings in same project

Result without automation: Just the effect box
Result with automation: Effect + TrackBox(es) + ValueRegionBox(es) + ValueEventBox(es) + ValueEventCurveBox(es)
Shell on paste: AudioUnitBox.audio-effects field
Exclusion: MIDIControllerBox (MIDI mappings shouldn't copy)
```

#### Copying MidiEffect (e.g., ZeitgeistDeviceBox)
```
ZeitgeistDeviceBox (new UUID)
├── host → AudioUnitBox.midi-effects (mandatory: false on target) → STOP (shell)
│
└── groove → GrooveBox (INTERNAL resource - STOP traversal)
        Without resource marking, would trace to RootBox via mandatory incoming edge!

Result: ZeitgeistDeviceBox + GrooveBox reference
Shell on paste: AudioUnitBox.midi-effects field
Paste behavior: Remap GrooveBox pointer to target project's existing GrooveBox (don't create new)
Note: GrooveBox marked as internal resource prevents pulling in entire project
```

#### Why AuxSendBox Needs Special Exclusion

```typescript
export const AuxSendBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AuxSendBox",
        fields: {
            1: {type: "pointer", name: "audio-unit", pointerType: Pointers.AuxSend, mandatory: true},
            2: {type: "pointer", name: "target-bus", pointerType: Pointers.AudioOutput, mandatory: true},
            // ...
        }
    }
}
```

The `target-bus` pointer is **mandatory** and points to `AudioBusBox`. If we followed this, we'd collect the entire bus routing system. Since bus routing is project-specific (not portable across projects), `AuxSendBox` is excluded by domain logic in `ProjectUtils`.

### Potential Future Resources

| Box Type | Resource Type | Reason |
|----------|---------------|--------|
| Custom sample library | `"external"` | References external sample pack |
| Preset bank | `"internal"` | Project-specific preset collection |
| Shared effect chain | `"internal"` | Reusable within project |

The `resource` property makes it easy to mark new resource types with appropriate copy semantics.
