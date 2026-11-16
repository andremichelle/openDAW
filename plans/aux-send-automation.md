# Aux Send Automation

The send knobs in the mixer (pan and gain) had no context menu, so they could not be automated, modulated or
mapped to a MIDI controller, while every other mixer control could.

## Findings

1. `AuxSendBox.sendGain` and `sendPan` already accept automation, modulation and MIDI pointers
   (`ParameterPointerRules`).
2. `AuxSendBoxAdapter` exposes both as `AutomatableParameterFieldAdapter`.
3. The engine binds both through the same gain/pan binder as the channel strip (`bind_send_automation`), including
   modulation, and follows the box values otherwise, which is what a MIDI connection writes.
4. Only the UI was missing: `AuxSend.tsx` rendered the knobs without `AutomationControl`.

## Change

1. Wrap both send knobs in `AutomationControl`, like the pan knob of `ChannelStrip`, with the audio unit's tracks as
   the lane owner.

## Lane Name

1. A send lane header showed the box name ("AuxSendBox") because `TrackBoxAdapter` falls back to `box.name` when the
   target has no label. Lanes created by scripts showed it too.
2. `ParameterOwner` names a send after its target bus ("Send FX", or "Send" without a target) and follows a bus
   rename and a rewire. `TrackBoxAdapter` uses it for the lane header.
3. Covered by `AuxSendTrackLabels.test.ts`.

## Process

AI-assisted (Claude Code): code analysis, the change, type-check, lint, studio tests, and a manual check in the
running studio (context menu on both knobs, automation lane creation and its "Send FX" header).
