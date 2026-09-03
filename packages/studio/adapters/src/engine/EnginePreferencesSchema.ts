import {z} from "zod"

const _BeatSubDivisionOptions = [1, 2, 4, 8] as const
const _RecordingCountInBars = [1, 2, 3, 4, 5, 6, 7, 8] as const
const _OlderTakeActionOptions = ["disable-track", "mute-region"] as const
const _OlderTakeScopeOptions = ["none", "all", "previous-only"] as const
// Bounds of the two free numeric settings. Editors have to clamp to them, since a value outside the
// bound fails the schema and costs the user that whole settings section on the next load.
// Input latency is a number of seconds, or one of the InputLatency sentinels: -1 equals the output
// latency, -3 takes whatever latency the capture's own MediaStreamTrack reports. The most negative
// sentinel is the field's lower bound.
const _InputLatencyMinimum = -3
// Metronome gain is attenuation only, in decibel.
const _MetronomeGainMaximum = 0
const _InputLatencyCalibrationEntry = z.object({
    deviceId: z.string(),
    inputLatency: z.number().min(0),
    outputLatencyAtCalibration: z.number().min(0),
    spread: z.number().min(0),
    measuredAt: z.number()
})

export const EngineSettingsSchema = z.object({
    metronome: z.object({
        enabled: z.boolean(),
        beatSubDivision: z.union(_BeatSubDivisionOptions.map(value => z.literal(value))),
        gain: z.number().min(Number.NEGATIVE_INFINITY).max(_MetronomeGainMaximum),
        monophonic: z.boolean()
    }).default({
        enabled: false,
        beatSubDivision: 1,
        gain: -6.0,
        monophonic: true
    }),
    playback: z.object({
        timestampEnabled: z.boolean(),
        pauseOnLoopDisabled: z.boolean(),
        truncateNotesAtRegionEnd: z.boolean()
    }).default({
        timestampEnabled: true,
        pauseOnLoopDisabled: false,
        truncateNotesAtRegionEnd: false
    }),
    debug: z.object({
        dspLoadMeasurement: z.boolean()
    }).default({
        dspLoadMeasurement: false
    }),
    recording: z.object({
        countInBars: z.union(_RecordingCountInBars.map(value => z.literal(value))),
        allowTakes: z.boolean(),
        automationEnabled: z.boolean(),
        olderTakeAction: z.union(_OlderTakeActionOptions.map(value => z.literal(value))),
        olderTakeScope: z.union(_OlderTakeScopeOptions.map(value => z.literal(value))),
        inputLatency: z.number().min(_InputLatencyMinimum),
        // Replaced wholesale on write; entries are keyed by the capture device id, which is per browser
        // and per origin.
        inputLatencyCalibrations: z.array(_InputLatencyCalibrationEntry).default([])
    }).default({
        countInBars: 1,
        allowTakes: true,
        automationEnabled: true,
        olderTakeAction: "mute-region",
        olderTakeScope: "previous-only",
        inputLatency: _InputLatencyMinimum, // the Reported sentinel
        inputLatencyCalibrations: []
    })
})

export type EngineSettings = z.infer<typeof EngineSettingsSchema>
export type InputLatencyCalibrationEntry = z.infer<typeof _InputLatencyCalibrationEntry>

export namespace EngineSettings {
    export const InputLatencyMinimum = _InputLatencyMinimum
    export const MetronomeGainMaximum = _MetronomeGainMaximum
    export const BeatSubDivisionOptions = _BeatSubDivisionOptions
    export const RecordingCountInBars = _RecordingCountInBars
    export const OlderTakeActionOptions = _OlderTakeActionOptions
    export const OlderTakeScopeOptions = _OlderTakeScopeOptions
}