# Mid/Side Split

Processes the mid and the side of the signal through their own effect chains, then recombines them.

---

![screenshot](mid-side-composite.webp)

---

## 0. Overview

_Mid/Side Split_ separates the incoming stereo signal into its **mid** (what both channels share, the centre) and its **side** (what differs between them, the width). Each gets its own serial chain of effects, and the two are summed back into one stereo signal.

The layers are **fixed**: there are always exactly two, Mid and Side, and they cannot be added, removed or reordered. Each layer is otherwise a full effect chain you build and edit yourself.

Example uses:

1. Mid/side EQ: put a Revamp in each layer to shape the centre and the width separately
2. Cleaning up the low end: cut the lows in the Side layer so bass and kick stay mono
3. Widening: lift the highs in the Side layer, or add a reverb there only
4. Compressing the centre (vocal, kick, snare) without touching the stereo room

A Mid/Side Split with no effects in either layer recombines the signal, so an empty one is a transparent pass-through.

---

## 1. Layers (Mid and Side)

The list always holds two layers:

1. **Mid**: the sum of both channels, played on both channels.
2. **Side**: the difference of the channels, played in opposite phase on the right.

An effect with a spectrum display, like Revamp, shows only the mid inside the Mid layer and only the side inside the Side layer.

---

## 2. Layer Controls

Each layer has its own small channel strip, matching a track header:

**Gain**: the layer's output level in decibels, applied before it rejoins the sum. Turning Side up widens the image, turning it down narrows it.

**Pan**: places the layer in the stereo field.

**Mute (M)**: drops that layer from the output. Muting Side leaves the mono signal.

**Solo (S)**: plays only the soloed layer, so you hear the centre or the width on its own while you edit it.

---

## 3. Editing a Layer

Click the device icons of a layer to enter it. The device panel then shows that layer's chain on its own, with the composite's name as a **back** button in the header. Add, remove, reorder and edit devices inside the layer like any other effect chain, then click the back button to return.

---

## 4. Dry

Level of the original, unprocessed input signal, in decibels. By default Dry is off (−∞), so you hear only the two layers.

---

## 5. Wet

Level of the recombined layer outputs, in decibels. By default Wet is at 0 dB.

---

## 6. Drag & Drop

1. **An existing effect onto a layer**: moves that effect into the Mid or Side chain. A drop never creates a new layer.
2. **An effect onto the back button (inside a layer)**: moves the effect out of the layer and onto the parent chain, next to the composite.

---

## 7. Technical Notes

1. Mid is `(L + R) / 2` on both channels, Side is `(L − R) / 2` on the left and its inverse on the right. Their sum is the original left and right.
2. A soloed Mid plays the mono sum at its real level.
3. A stereo effect in one layer can reach the other. A reverb in Mid adds width, a stereo widener in Side can add centre. That is how the layers stay full stereo chains.
4. When an effect in one layer delays its signal (look-ahead), the other layer is delayed to match, so the two stay aligned.
5. An EQ that boosts or cuts strongly in only one layer shifts the phase there, which moves the stereo image slightly at those frequencies. Every mid/side EQ does this.
