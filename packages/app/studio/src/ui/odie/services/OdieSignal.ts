export type OdieSignal =
    | { type: "project-loaded", name: string }
    | { type: "track-added", name: string, kind: string }
    | { type: "effect-added", track: string, effect: string }
    | { type: "region-created", track: string, time: number }
    | { type: "note-added", track: string, pitch: number, start: number }
    | { type: "param-changed", track: string, param: string, value: number }
    | { type: "analysis-complete", track: string, result: any }
    | { type: "thought-complete", content: string }
    | { type: "mindset-changed", mode: string }
    | { type: "tool-executed", tool: string, success: boolean }
    | { type: "api-rotated", providerId: string }
    | { type: "info", message: string }
    | { type: "success", message: string }
    | { type: "error", message: string }
