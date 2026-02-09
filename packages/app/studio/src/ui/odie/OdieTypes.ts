import { AudioUnitType } from "@opendaw/studio-enums"

export const PPQN = 960

export type OdieEvent =
    | { type: "chat-message", message: string }
    | { type: "command-executed", command: string }
    | { type: "project-loaded", name: string }
    | { type: "note-added", track: string, pitch: number, start: number }
    | { type: "region-created", track: string, time: number }
    | { type: "effect-added", track: string, effect: string }
    | { type: "param-changed", track: string, param: string, value: number }
    | { type: "error", message: string }
    | { type: "action-complete", command?: string, result?: Record<string, unknown>, content?: string }
    | { type: "track-deleted", name: string }
    | { type: "track-added", name: string, kind: string }
    | { type: "analysis-complete", track: string, result: AnalysisResult }
    | { type: "ui-feedback", message: string, targetId?: string }

// ═══════════════════════════════════════════════════════════════════════════
// ODIE DATA INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

/** Parameter metadata extracted for AI response */
export interface ParameterInfo {
    value: number | boolean | string
    min?: number
    max?: number
}

/** Recursive parameter tree (can have nested groups like osc1.wave) */
export interface ParameterTree {
    [key: string]: ParameterInfo | ParameterTree
}

/** Effect/MIDI Effect details for getTrackDetails */
export interface EffectDetails {
    index: number
    type: string
    label: string
    enabled: boolean
    parameters: ParameterTree
}

/** Instrument details for getTrackDetails */
export interface InstrumentDetails {
    type: string
    label: string
    parameters: ParameterTree
}

/** Full track details returned by getTrackDetails */
export interface TrackDetails {
    track: string
    type: AudioUnitType
    mixer: {
        volume: number
        panning: number
        mute: boolean
        solo: boolean
    }
    midiEffects: EffectDetails[]
    audioEffects: EffectDetails[]
    instrument: InstrumentDetails | null
}


export interface MidiNoteDef {
    startTime: number
    duration: number
    pitch: number
    velocity: number
}

/** Structured tool result for better error reporting */
export interface ToolResult<T = any> {
    success: boolean
    reason?: string
    message?: string
    userMessage?: string
    systemError?: string
    data?: T
    analysisData?: any
}

export interface RegionAnalysis {
    start: number
    duration: number
    name: string
    kind: "midi" | "audio" | "unknown"
    notes?: number
}

export interface AnalysisResult {
    track: string
    regions: RegionAnalysis[]
}
