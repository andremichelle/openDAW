# Region canvas visibility

A hidden region lane can lose its canvas contents during resize. Its model data remains unchanged,
so the previous data-update flag can suppress the first repaint when the lane becomes visible again.
Request a repaint on each visibility entry; rendering remains suspended while hidden.

Codex assisted the fix and regression test. The test paints a lane, hides it, simulates the hidden
canvas paint, and verifies that re-entry requests a fresh paint and renders the unchanged regions.
