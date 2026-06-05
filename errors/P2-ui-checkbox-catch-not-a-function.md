# UI Checkbox catch-not-a-function

- **status:** ALREADY FIXED (commit `7cac185c6`, 2026-03-23) · **priority:** P2
- **occurrences:** 2 · **ids:** [815, 816] (reported 2026-03-16, one week before the fix)
- **root cause:** At the report build the MIDI factory was a **non-async** arrow `Promises.memoizeAsync(() => navigator.requestMIDIAccess({sysex: false}))`, so `factory()` returned `requestMIDIAccess`'s value *directly*. On the reporting host that value was a non-Promise/thenable lacking `.catch`, so `memoizeAsync`'s `resolving.catch(...)` (`promises.ts:147`) threw `l.catch is not a function`.
- **fix (already shipped):** `7cac185c6 "may fix 863"` wrapped the factory in `async () => { const result = await navigator.requestMIDIAccess(...); ... }` (`MidiDevices.ts:61-67`). An async function always returns a native Promise regardless of what `requestMIDIAccess` yields, so `resolving.catch` is always defined. Crash eliminated at the call site, where the contract violation actually was.
- **no change to `memoizeAsync`:** its `Provider<Promise<T>>` contract already requires a real Promise; wrapping the result in `Promise.resolve()` would be a band-aid masking caller contract violations. The real bug was the non-async caller, now corrected.

[< back to index](error-triage.md)

## Reports

### TypeError: l.catch is not a function. (In 'l.catch(p=>(l=null,p))', 'l.catch' is undefined)
- **occurrences:** 2 · **ids:** [815, 816] · **span:** 2026-03-16->2026-03-16 · **builds:** 1 · **browsers:** ?/macOS
- **source:** `src/ui/components/Checkbox.tsx:21`
- **stack:**
  - `@../../../lib/runtime/dist/promises.js:126:32 (error)`
  - `requestPermission@../../../studio/core/dist/midi/MidiDevices.js:52:86 (#memoizedRequest)`
  - `requestPermission@../../../studio/core/dist/midi/MidiDevices.js:66:4`
  - `setValue@../../../studio/core/dist/midi/MidiDevices.js:132:39`

## Investigation (root cause + recommended fix)

**Root cause:** `Promises.memoizeAsync` assumes `factory()` returns a real Promise and calls `.catch` on the result without guarding: `resolving = factory(); resolving.catch(...)` at `packages/lib/runtime/src/promises.ts:146-147`. The minified error `l.catch(p=>(l=null,p))` maps exactly to that `resolving.catch(error => { resolving = null; return error })`. The factory here is `MidiDevices.#memoizedRequest` (`packages/studio/core/src/midi/MidiDevices.ts:61-67`), whose body awaits `navigator.requestMIDIAccess({sysex: false})`. The build target is `esnext` (`packages/app/studio/vite.config.ts:38,56`), so the `async` wrapper is NOT down-levelled and would normally always yield a native Promise. The only way `resolving.catch` is `undefined` is that `factory()` itself returned a non-Promise, i.e. `navigator.requestMIDIAccess` is present (`canRequestMidiAccess()` passes at `MidiDevices.ts:25` via `"requestMIDIAccess" in navigator`) but a polyfill/extension/uncommon browser (report browser is "?") replaced it with a thenable/non-Promise. `memoizeAsync` then propagates that non-Promise and crashes when it touches `.catch`. The defect is the missing normalization in `memoizeAsync`, not in MidiDevices.

**Evidence:** Stack: `Checkbox.tsx:21 model.setValue` → `MidiDevices.ts:162 scope.requestPermission().finally(...)` → `requestPermission` → `#memoizedRequest()` → `promises.js:126 resolving.catch (error)`. Dist `promises.js` (lines 124-126) is identical to src `promises.ts:146-147`.

**Recommended fix:** In `memoizeAsync` wrap the factory result so it is always a real Promise: `resolving = Promise.resolve(factory())` before `resolving.catch(...)` (`promises.ts:146`). This makes the memoizer robust to factories/host APIs that return non-Promise thenables and removes the only line that can throw `.catch is not a function`. If confirmation of the offending browser is wanted, add a one-time `console.debug` in `MidiDevices.#memoizedRequest` logging `typeof navigator.requestMIDIAccess` and the constructor name of its return value.
