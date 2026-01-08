export type OdieEvent =
    | { type: "chat-message", message: string }
    | { type: "command-executed", command: string }
    | { type: "project-loaded", name: string }
    | { type: "note-added", track: string, pitch: number, start: number }
    | { type: "region-created", track: string, time: number }
    | { type: "effect-added", track: string, effect: string }
    | { type: "param-changed", track: string, param: string, value: number }
    | { type: "error", message: string }
    | { [key: string]: any }
