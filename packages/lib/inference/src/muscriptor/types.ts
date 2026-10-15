export interface MuScriptorNote {
    readonly start: number
    readonly end: number
    readonly pitch: number
    readonly velocity: number
    readonly program: number
    readonly instrument: string
    readonly isDrum: boolean
}

export interface MuScriptorInput {
    readonly channels: ReadonlyArray<Float32Array>
    readonly sampleRate: number
    readonly start: number
    readonly end: number
}

export type MuScriptorPhase = "download" | "cache" | "load" | "transcribe"
export interface MuScriptorProgress {
    readonly phase: MuScriptorPhase
    readonly value: number
}

export type MuScriptorWorkerResponse =
    | {kind: "progress", value: MuScriptorProgress}
    | {kind: "result", notes: ReadonlyArray<MuScriptorNote>}
    | {kind: "error", message: string}

export interface MuScriptorWorkerRequest {
    readonly input: MuScriptorInput
    readonly assets: Record<string, Uint8Array>
}
