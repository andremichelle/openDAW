# Reverse audio clips and regions

Related to [Audio clip utilities #413](https://github.com/andremichelle/openDAW/issues/413).

Right-click an audio clip in the launcher or an audio region in the arrangement and choose **Revert**, or select it and press **Shift+V**. The command reverses the source frames covered by the clip or region. If an arrangement region wraps, it reverses one full loop. File bounds still limit playback. Edits to placement, gain, fades and warp markers stay in the timeline. Undo restores the previous sample reference for the whole selection.

This AI-assisted change reuses the Sample Editor's Reverse effect and the existing sample import and transient detection paths. Each selected item points to a derived sample. Selected items with the same source and frame range share a copy. Other users of the source keep their existing reference. The editor and engine follow file-pointer edits so the waveform and transient markers update after the change or undo.
