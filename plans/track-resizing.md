# Timeline track resizing

AI-assisted implementation requested by the user: resize individual timeline tracks by dragging in the UI.

- Each audio-unit track and modulator automation track has a five-pixel bottom-edge drag handle confined to the left control header's divider. Hover shows a one-pixel line using the shared green color at 50% opacity; double-click resets to the theme's default height. Clip and waveform areas do not initiate track resizing.
- Heights are bounded by the default lane height and 480 pixels. TrackBox field 31 stores the height in pixels; zero means the theme default, preserving existing projects. The box schema generates both TypeScript boxes and the Rust registry.
- Double-clicking empty background in the left control header also restores the default height. Child controls and labels keep their existing interactions.
- Drag updates use the project's editing transaction with a single undo mark on completion. Cancellation restores the original value. Subscriptions and pointer handlers belong to the track lifecycle.
- The row's height changes directly, preserving the shared `--lane-height` token used for clip column widths. Track hit testing reads actual element dimensions, and CanvasPainter observes canvas resizing.
- Validation: Studio TypeScript check, existing Studio unit tests, and compilation of the track Sass. Browser interaction remains to be checked manually: resize audio/MIDI/automation lanes, scroll and edit clips below them, undo/redo, cancel with Escape, reset with double-click, and reopen a saved project.

## Review follow-up

- Following the agreed review layout, clip cells fill the entire track height while retaining shared column widths. The circular preview, progress ring and play/pause control retain their default size and center vertically beneath the label, so taller rows do not stretch or crop the content.
- The resize handle starts 36 pixels into the header, leaving the automation-collapse button clear.
- Clip lanes and the launch header share a pixel scroll offset. Horizontal trackpad gestures and Shift+wheel scroll continuously; vertical wheel input keeps scrolling tracks. Capture, rectangle selection, moving clips, and drop previews account for the offset. Extra columns include one empty destination after the last clip.
- Code style follows the maintainer feedback: checked header lookup, field-derived maximum, import placement, custom properties before the handle styles, and preserved original file endings.
- Keyboard resizing was explicitly deferred by the user.

## Full-height clip review revision

The maintainer requested full-area clip cells with centered circular content and play/pause controls. The clip cell now fills the row height; its content overlays keep their default square size, centered below the label. Column widths and scroll/hit-test coordinates remain shared across rows. Fresh checks: all 62 Studio tests, Studio `tsc --noEmit`, Sass compilation with the app alias resolver and `git diff --check` passed. Browser security policy blocked the visual test page, so visual verification of this revision remains outstanding.
