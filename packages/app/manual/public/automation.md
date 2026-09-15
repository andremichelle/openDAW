# Automation Editing

The automation editor allows you to create and edit parameter automation curves. Each automation lane displays events
connected by curves that control how a parameter changes over time.

---

![screenshot](automation.webp)

---

## 0. Overview

Automation events are points on a timeline that define parameter values. Between events, the value transitions according
to the curve shape (linear or curved). The editor supports both parameter automation (normalized 0-1 values) and tempo
automation (BPM values).

---

## 1. Creating Automation Lanes

To automate a parameter:

1. **Right-click** on any automatable control (knob, slider, button) in a device
2. Select **Create Automation** from the context menu
3. An automation lane appears in the timeline below the track

Once created, the automation lane shows the parameter name and allows you to draw automation curves that control the
parameter over time.

---

## 2. Events

### 2.1 Creating Events

- **Double-click** on empty space to create a new event at that position and value
- **⇧ + click + drag** to create a new event and immediately drag it to position
- Events snap to the current grid when snapping is enabled
- Values snap to the current anchor value (shown as dashed horizontal line) when close

### 2.2 Selecting Events

- **Click** an event to select it
- **Click + drag** on empty space to create a selection rectangle
- **⌘A** to select all events
- **⇧⌘A** to deselect all events

### 2.3 Moving Events

- **Click + drag** a selected event to move all selected events
- Events snap to grid positions and to other event values
- Hold **⇧** to disable value snapping
- Hold **⌥** to copy events instead of moving them
- Hold **⌥⇧** to create mirrored copies

### 2.4 Deleting Events

- **Double-click** an event to delete it
- Select events and press **⌫** (Backspace) or **Delete** to delete selection

### 2.5 Editing Values

To set a precise value for selected events:

1. Select one or more events
2. Press **Enter** to open a floating text input near your cursor
3. Type the new value (the current value is shown as placeholder)
4. Press **Enter** to confirm or **Escape** to cancel

The input accepts the parameter's native unit (e.g., "440 Hz", "50%", "-12 dB", "120 bpm").

---

## 3. Curves

### 3.1 Curve Types

Events can transition to the next event using different interpolation types:

- **Linear**: Straight line between events (default when double-clicking)
- **Curved**: Smooth curve with adjustable slope
- **None**: Instant jump to next value (step automation)

### 3.2 Midpoint Handle

Between two events with linear or curved interpolation, a small **midpoint handle** appears on the curve. This handle
lets you adjust the curve shape.

### 3.3 Adjusting Curve Slope

- **Click + drag** the midpoint handle vertically to bend the curve
- The curve automatically snaps to linear (straight) when close to center
- Hold **⌥** for fine control (10x slower adjustment)
- Hold **⇧** to disable snapping to linear

### 3.4 Cutting Curves

- Hold **⌥** and **click** on a midpoint to cut the curve, creating a new event at that position

---

## 4. Content Duration

Automation clips and regions can loop. You can adjust the content duration:

- **Click + drag** the right edge marker to change where the content loops
- The marker appears as a vertical line at the end of the content region

---

## 5. Keyboard Shortcuts

| Shortcut           | Action                 |
|--------------------|------------------------|
| **⌘A**             | Select all events      |
| **⇧⌘A**            | Deselect all events    |
| **⌫** / **Delete** | Delete selected events |
| **Enter**          | Edit value numerically |
| **\\**             | Zoom to content        |
| **←** / **→**      | Move playback position |

---

## 6. Mouse Actions Summary

| Action                   | Result                        |
|--------------------------|-------------------------------|
| Double-click empty space | Create event                  |
| Double-click event       | Delete event                  |
| ⇧ + click + drag         | Create event and drag         |
| Click + drag event       | Move selected events          |
| Click + drag empty space | Selection rectangle           |
| Click + drag midpoint    | Adjust curve slope            |
| ⌥ + click curve/midpoint | Cut curve at position         |
| ⌘ + click + drag         | Paint mode (draw values)      |

---

## 7. Modifier Keys

| Modifier             | Effect                                                               |
|----------------------|----------------------------------------------------------------------|
| **⌥** (Option/Alt)   | Copy events when dragging, fine control for slopes, cut on curve     |
| **⇧** (Shift)        | Create new event (click+drag), disable value/linear snapping         |
| **⌘** (Command/Ctrl) | Paint mode                                                           |

---

## 8. Tips

- Watch the tooltip when hovering over events or midpoints to see the current value
- Use the anchor value (horizontal dashed line) to align events to a specific value
- Right-click for context menu options on events
