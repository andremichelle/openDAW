
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { OdieToolExecutor, ExecutorContext } from './OdieToolExecutor'
import { mockStudio } from './mocks/MockStudioService'
import { OdieAppControl } from './OdieAppControl'
import { StudioService } from '@/service/StudioService'
import { NoteRegionBoxAdapter } from '@opendaw/studio-adapters'

// 1. Mock the Adapters Module (Hoisted)
vi.mock('@opendaw/studio-adapters', async (importOriginal) => {
    const original = await importOriginal<any>()

    // Create a mock class for instanceof checks
    class MockNoteRegionBoxAdapter {
        position = 0
        duration = 0
        complete = 0
        optCollection = { unwrap: () => ({ createEvent: vi.fn(), asArray: () => [] }) }
    }

    return {
        ...original,
        NoteRegionBoxAdapter: MockNoteRegionBoxAdapter,
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

describe('Odie Generative Verification', () => {
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
                focus: {}
            },
            recentMessages: []
        }
    })


    describe('The C-Major Scale Test', () => {
        it('should add notes to an existing region on the track', async () => {
            const trackName = "Lead Synth"
            mockStudio.addFakeTrack(trackName)

            // Mock the region
            const mockCreateEvent = vi.fn()

            // Create an instance of the mocked class
            const fakeRegion = Object.create(NoteRegionBoxAdapter.prototype) as any
            fakeRegion.position = 0
            fakeRegion.duration = 16
            fakeRegion.complete = 16
            fakeRegion.optCollection = {
                unwrap: () => ({
                    createEvent: mockCreateEvent,
                    asArray: () => []
                })
            }
            // Manually inject the region into the adapter
            // Type-cast to any because we are extending the mock dynamically
            const adapter = (mockStudio as any)._fakeAdapters.find((a: any) => a.label === trackName)
            adapter.regions = { collection: { asArray: () => [fakeRegion] } }

            // Define C-Major Scale Notes
            const cMajorScale = [
                { pitch: 60, startTime: 1, duration: 1, velocity: 100 }, // C4
                { pitch: 62, startTime: 2, duration: 1, velocity: 100 }, // D4
                { pitch: 64, startTime: 3, duration: 1, velocity: 100 }, // E4
                { pitch: 65, startTime: 4, duration: 1, velocity: 100 }, // F4
                { pitch: 67, startTime: 5, duration: 1, velocity: 100 }, // G4
                { pitch: 69, startTime: 6, duration: 1, velocity: 100 }, // A4
                { pitch: 71, startTime: 7, duration: 1, velocity: 100 }, // B4
                { pitch: 72, startTime: 8, duration: 1, velocity: 100 }  // C5
            ]

            const result = await executor.execute({
                id: "mock-id",
                name: "notes_add",
                arguments: {
                    trackName: trackName,
                    notes: cMajorScale
                }
            }, ctx)

            expect(result.success).toBe(true)
            expect(result.userMessage).toContain("Added 8 MIDI notes")
            expect(mockCreateEvent).toHaveBeenCalledTimes(8)

            // Verify correct pitch mapping
            expect(mockCreateEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ pitch: 60 }))
            expect(mockCreateEvent).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 72 }))
        })
    })
})
