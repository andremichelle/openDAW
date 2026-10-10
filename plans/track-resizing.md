# Timeline track resizing

AI-assisted implementation requested by the user: resize individual timeline tracks by dragging in the UI.

- Each audio-unit track and modulator automation track has a five-pixel bottom-edge drag handle confined to the left control header's divider. Hover shows a one-pixel line using the shared green color at 50% opacity; double-click resets to the theme's default height. Clip and waveform areas do not initiate track resizing.
- Heights are bounded by the default lane height and 480 pixels. TrackBox field 31 stores the height in pixels; zero means the theme default, preserving existing projects. The box schema generates both TypeScript boxes and the Rust registry.
- Double-clicking empty background in the left control header also restores the default height. Child controls and labels keep their existing interactions.
- Drag updates use the project's editing transaction with a single undo mark on completion. Cancellation restores the original value. Subscriptions and pointer handlers belong to the track lifecycle.
- The row's height changes directly, preserving the shared `--lane-height` token used for clip column widths. Track hit testing reads actual element dimensions, and CanvasPainter observes canvas resizing.
- Validation: Studio TypeScript check, existing Studio unit tests, and compilation of the track Sass. The user tested the UI locally. The rebuilt WASM engine passed synchronization/checksum tests (initial sync plus 263 transactions). Further reviewer checks: audio/MIDI/automation lanes, scrolling and editing clips below resized lanes, undo/redo, cancellation with Escape, double-click reset, and reopening a saved project.
