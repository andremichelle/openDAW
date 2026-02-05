export type OdieEvent =
    | { type: "chat-message", message: string }
    | { type: "command-executed", command: string }
    | { type: "project-loaded", name: string }
    | { type: "note-added", track: string, pitch: number, start: number }
    | { type: "region-created", track: string, time: number }
    | { type: "effect-added", track: string, effect: string }
    | { type: "param-changed", track: string, param: string, value: number }
    | { type: "error", message: string }
    | { type: "action-complete", command?: string, result?: any, content?: string }
    | { type: "track-added", name: string, kind: string }
    | { type: "analysis-complete", track: string, result: any }
