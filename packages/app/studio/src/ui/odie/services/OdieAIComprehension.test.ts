
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mocking the engine factories to ensure grounding tests pass regardless of registry state
vi.mock('@opendaw/studio-adapters', async (importOriginal) => {
    const original = await importOriginal<any>()
    return {
        ...original,
        InstrumentFactories: {
            Nano: { defaultName: 'Nano' },
            Playfield: { defaultName: 'Playfield' },
            Soundfont: { defaultName: 'Soundfont' },
            Vaporisateur: { defaultName: 'Vaporisateur' },
            Tape: { defaultName: 'Tape' },
            MIDIOutput: { defaultName: 'MIDIOutput' },
            Named: {}
        }
    }
})

import { OdieToolExecutor, ExecutorContext } from './OdieToolExecutor'
import { OdieTools } from './OdieToolDefinitions'
import { mockStudio } from './mocks/MockStudioService'
import { OdieAppControl } from './OdieAppControl'
import { StudioService } from '@/service/StudioService'
import { InstrumentFactories } from '@opendaw/studio-adapters'

describe('Odie AI Comprehension', () => {
    let executor: OdieToolExecutor
    let ctx: ExecutorContext
    let appControl: OdieAppControl

    beforeEach(() => {
        mockStudio.reset()
        appControl = new OdieAppControl(mockStudio as unknown as StudioService)
        executor = new OdieToolExecutor()

        ctx = {
            studio: mockStudio as unknown as StudioService,
            appControl,
            ai: {} as any,
            setGenUiPayload: vi.fn(),
            setSidebarVisible: vi.fn(),
            contextState: {
                focus: {
                    selectedTrackName: "Kick"
                }
            },
            recentMessages: []
        }
    })

    describe('Tool Parity Audit', () => {
        it('should handle EVERY tool defined in OdieToolDefinitions', async () => {
            for (const tool of OdieTools) {
                const args: any = {}

                // Fill required args based on schema to satisfy basic validation
                if (tool.name === 'transport_set_bpm') args.bpm = 120
                if (tool.name === 'transport_set_time_signature') { args.numerator = 4; args.denominator = 4 }
                if (tool.name === 'transport_loop') args.enabled = true
                if (tool.name === 'transport_set_count_in') args.bars = 1
                if (tool.name === 'mixer_volume') { args.trackName = "Kick"; args.db = -6 }
                if (tool.name === 'mixer_pan') { args.trackName = "Kick"; args.pan = 0 }
                if (tool.name === 'mixer_mute') { args.trackName = "Kick"; args.muted = true }
                if (tool.name === 'mixer_solo') { args.trackName = "Kick"; args.soloed = true }
                if (tool.name === 'arrangement_add_track' || tool.name === 'track_add') { args.type = "synth"; args.name = "Lead" }
                if (tool.name === 'arrangement_delete_track' || tool.name === 'track_delete') args.name = "Lead"
                if (tool.name === 'arrangement_add_midi_effect') { args.trackName = "Kick"; args.effectType = "arpeggio" }
                if (tool.name === 'arrangement_add_bus') args.name = "Reverb Bus"
                if (tool.name === 'mixer_add_send') { args.trackName = "Kick"; args.auxName = "Aux 1" }
                if (tool.name === 'mixer_add_effect') { args.trackName = "Kick"; args.effectType = "delay" }
                if (tool.name === 'mixer_set_routing') { args.sourceName = "Kick"; args.targetBusName = "Master" }
                if (tool.name === 'get_track_details') args.trackName = "Kick"
                if (tool.name === 'analyze_track') args.trackName = "Kick"
                if (tool.name === 'set_device_param') {
                    args.trackName = "Kick"
                    args.deviceType = "instrument"
                    args.paramPath = "cutoff"
                    args.value = 0.5
                }
                if (tool.name === 'notes_add') {
                    args.trackName = "Kick"
                    args.notes = [{ pitch: 60, startTime: 1, duration: 1, velocity: 100 }]
                }
                if (tool.name === 'notes_get') args.trackName = "Kick"
                if (tool.name === 'view_switch') args.screen = "arrangement"
                if (tool.name === 'verify_action') { args.action = "mute"; args.expectedChange = "muted" }
                if (tool.name === 'region_split') args.trackName = "Kick"
                if (tool.name === 'region_move') { args.trackName = "Kick"; args.time = 0; args.newTime = 4 }
                if (tool.name === 'region_copy') { args.trackName = "Kick"; args.time = 0; args.newTime = 4 }

                const result = await executor.execute({ id: "mock-id", name: tool.name, arguments: args }, ctx)
                expect(result.systemError ?? "").not.toContain('Unknown Tool')
            }
        })
    })

    describe('Musical Grounding', () => {
        it('should associate "drums" with "playfield" in add_track', async () => {
            mockStudio.addFakeTrack("Beat")
            const result = await appControl.addTrack("drums", "Beat")
            expect(result.success).toBe(true)
            expect(mockStudio.project.api.createInstrument).toHaveBeenCalledWith(InstrumentFactories.Playfield, expect.any(Object))
        })

        it('should correctly handle "set_device_param" for common musical paths', async () => {
            mockStudio.addFakeTrack("Lead")
            const result = await executor.execute({
                id: "mock-id",
                name: "set_device_param",
                arguments: {
                    trackName: "Lead",
                    deviceType: "instrument",
                    paramPath: "cutoff",
                    value: 0.8
                }
            }, ctx)
            expect(result.success).toBe(true)
        })
    })

    describe('Workflow Integrity (Discovery Sequence)', () => {
        it('should return error if track name missing and cannot be inferred', async () => {
            ctx.contextState.focus = {}
            ctx.recentMessages = []

            await expect(executor.execute({ id: "mock-id", name: "get_track_details", arguments: {} }, ctx))
                .rejects.toThrow("No track specified")
        })

        it('should successfully infer track from recent messages if omitted', async () => {
            mockStudio.addFakeTrack("Sub Bass")
            ctx.contextState.focus = {}
            ctx.recentMessages = [
                { id: "msg-123", timestamp: Date.now(), role: "user", content: "Tell me about the Sub Bass" }
            ]

            const result = await executor.execute({ id: "mock-id", name: "get_track_details", arguments: {} }, ctx)
            expect(result.success).toBe(true)
            expect(result.analysisData).toContain('Sub Bass')
        })
    })

    describe('Output Integrity', () => {
        it('should return valid data structure in analysisData', async () => {
            mockStudio.addFakeTrack("Kick")
            const result = await executor.execute({ id: "mock-id", name: "get_track_details", arguments: { trackName: "Kick" } }, ctx)

            expect(result.success).toBe(true)
            expect(typeof result.analysisData).toBe('string')
            expect(result.analysisData).toContain('"track": "Kick"')
        })
    })
})
