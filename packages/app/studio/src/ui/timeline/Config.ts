import {Padding} from "@opendaw/lib-std"

export const Config = {
    AutoScrollHorizontalSpeed: 0.25,
    AutoScrollPadding: [0, 16, 0, 0] satisfies Padding,
    AutoScrollDragPadding: [24, 16, 24, 0] satisfies Padding,
    AutoScrollDragPaddingVertical: [24, 0, 24, 0] satisfies Padding,
    // pointer downs that never scroll the timeline: the track resizer and controls like the header knobs and buttons
    AutoScrollIgnore: ".track-resizer, [data-no-auto-scroll]"
} as const