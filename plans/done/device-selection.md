# Device Selection Implementation Plan

## Overview

Add device selection functionality to openDAW, allowing users to select devices with visual feedback in DeviceEditor.

**Key finding:** Device schemas already include `Pointers.Selection` via DeviceFactory - no schema changes needed.

---

## Files to Modify

1. `/packages/studio/core/src/project/Project.ts`
2. `/packages/app/studio/src/ui/devices/DeviceEditor.tsx`
3. `/packages/app/studio/src/ui/devices/DeviceEditor.sass`

---

## Step 1: Project.ts - Add deviceSelection

**Add import:**
```typescript
import {isVertexOfBox} from "@opendaw/studio-adapters"
```

**Add property (after `selection`):**
```typescript
readonly deviceSelection: FilteredSelection<DeviceBoxAdapter>
```

**Add initialization (in constructor, after `timelineFocus`):**
```typescript
this.deviceSelection = this.#terminator.own(this.selection.createFilteredSelection(
    isVertexOfBox(DeviceBoxUtils.isDeviceBox),
    {
        fx: (adapter: DeviceBoxAdapter) => adapter.box,
        fy: vertex => this.boxAdapters.adapterFor(vertex.box, Devices.isAny)
    }
))
```

---

## Step 2: DeviceEditor.tsx

**A) Add `onPointerDown` to header (line 91):**
```typescript
<header onPointerDown={event => {
    if (event.shiftKey) {
        project.deviceSelection.select(adapter)
    } else {
        project.deviceSelection.deselectAll()
        project.deviceSelection.select(adapter)
    }
}} onInit={...} style={...}>
```

**B) Add selection subscription to root div's `onInit` (lines 75-81):**
```typescript
onInit={element => {
    const updateSelected = () =>
        element.classList.toggle("selected", project.deviceSelection.isSelected(adapter))
    lifecycle.ownAll(
        enabledField.catchupAndSubscribe((owner: ObservableValue<boolean>) =>
            element.classList.toggle("enabled", owner.getValue())),
        minimizedField.catchupAndSubscribe((owner: ObservableValue<boolean>) =>
            element.classList.toggle("minimized", owner.getValue())),
        project.deviceSelection.catchupAndSubscribe({
            onSelected: updateSelected,
            onDeselected: updateSelected
        })
    )
}}
```

---

## Step 3: DeviceEditor.sass - Add Selected Style

**DONE** - Already added:
```sass
&.selected > header
  border-radius: 0 0 3px 3px
  background-color: rgba(white, 0.03)
```

---

## Verification

1. Run the app and open a project with devices
2. Click on a device - it should show selection outline
3. Click on another device - previous should deselect, new should select
4. Verify selection persists across minimized/enabled states