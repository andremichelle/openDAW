# Freeze AudioUnit

Freezing an audio unit renders its complete output offline into an audio buffer. While frozen, the track plays from this
cached audio instead of processing instruments and effects in real time — saving CPU. You can unfreeze at any time to
resume normal live processing.

---

## When to Freeze

Freeze is useful when your project becomes CPU-heavy. Instrument tracks with complex synthesizers or long effect chains
benefit the most. Freezing captures the post-effects signal, so the full sound is preserved while the DSP load drops
significantly.

---

## Freezing a Track

1. Right-click the track header of an instrument track to open the context menu
2. Select **Freeze AudioUnit**
3. A progress dialog shows the offline render advancing
4. Once complete, the track content area becomes semi-transparent, indicating the frozen state

While frozen:

- The instrument and all audio effects are bypassed (CPU saved)
- The **channel strip remains active** — volume, pan, mute, solo, and aux sends still work on the frozen audio
- Regions on the frozen track cannot be edited
- The capture device (recording arm) is automatically disarmed

---

## Unfreezing a Track

1. Right-click the track header (the header remains interactive while frozen)
2. Select **Unfreeze AudioUnit**
3. The track returns to normal appearance and live processing resumes

---

## Automatic Unfreezing

Frozen audio is rendered at a specific tempo. When the tempo changes, the cached audio would no longer be in sync with
the timeline. openDAW automatically unfreezes all frozen audio units when:

- The **project tempo (BPM)** is changed manually
- **Tempo automation** is added, removed, or modified
- Tempo automation is **enabled or disabled**

After an automatic unfreeze you can re-freeze the track to capture the audio at the new tempo.

---

## Sidechain Restriction

If an audio unit is used as a sidechain source by a device on another track (e.g., a compressor sidechained to your kick
drum), it cannot be frozen. Freezing would remove the live signal that the sidechain depends on.

Attempting to freeze such a track shows an info dialog explaining the restriction. You can still freeze the track that
*receives* the sidechain — only the source is restricted.

---

## Tips

- Freeze tracks you are done editing to free up CPU for other work
- Channel strip adjustments (volume, pan, sends) remain fully functional on frozen tracks, so you can continue mixing
- If you need to edit regions or change devices on a frozen track, unfreeze first
- After tempo changes, remember to re-freeze tracks that were automatically unfrozen
