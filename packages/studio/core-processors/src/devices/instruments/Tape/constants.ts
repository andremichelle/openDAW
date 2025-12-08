// All durations in seconds for sample-rate independence

/** Duration for voice fade-in/fade-out crossfades (~5ms) */
export const VOICE_FADE_DURATION: number = 0.020

/** Duration for loop boundary crossfades in Repeat/Pingpong (~5ms) */
export const LOOP_FADE_DURATION: number = 0.005

/** Margin at start of segment to skip attack when looping (~6ms) */
export const LOOP_MARGIN_START: number = 0.006

/** Margin at end of segment to avoid bleeding into next transient (~6ms) */
export const LOOP_MARGIN_END: number = 0.006
