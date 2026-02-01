/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mocking dependencies that hit the DOM/DB at top level
vi.mock('./OdieMemoryService', () => ({
    odieMemory: {
        saveFact: vi.fn(),
        queryFacts: vi.fn().mockResolvedValue([]),
        getAllFacts: vi.fn().mockResolvedValue([]),
        wipeMemory: vi.fn()
    }
}))

vi.mock('@/ui/components/dialogs', () => ({
    Dialogs: {
        info: vi.fn(),
        confirm: vi.fn()
    }
}))

import { OdieAppControl } from './OdieAppControl'
import { mockStudio } from './mocks/MockStudioService'
import { StudioService } from '@/service/StudioService'
import { OdieToolExecutor, ExecutorContext } from './OdieToolExecutor'

describe('Odie Resilience & Safety', () => {
    let appControl: OdieAppControl
    let executor: OdieToolExecutor
    let ctx: ExecutorContext

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

    describe('Defensive API Benchmarks (Malformed Inputs)', () => {
        it('should safely handle NaN or non-number volume/pan values', async () => {
            mockStudio.addFakeTrack("Lead")

            // Testing string where number expected
            const resultVolume = await appControl.setVolume("Lead", "string" as any)
            expect(resultVolume.success).toBe(false)
            expect(resultVolume.reason).toContain("number")

            const resultPan = await appControl.setPan("Lead", NaN)
            expect(resultPan.success).toBe(false)
            expect(resultPan.reason).toContain("number")
        })

        it('should reject out-of-range BPM or time signatures', async () => {
            // BPM range check in executor/logic
            const resultLow = await appControl.setBpm(-1)
            expect(resultLow.success).toBe(false)
        })

        it('should reject parameter paths that potentially attempt injection', async () => {
            mockStudio.addFakeTrack("Lead")
            const result = await appControl.setDeviceParam("Lead", "instrument", 0, "__proto__.foo", 1)
            expect(result.success).toBe(false)
        })
    })

    describe('Transaction & Concurrency Integrity', () => {
        it('should handle rapid concurrent transport calls without race conditions', async () => {
            const p1 = appControl.play()
            const p2 = appControl.stop()
            await Promise.all([p1, p2])
            expect(mockStudio.engine.play).toHaveBeenCalled()
            expect(mockStudio.engine.stop).toHaveBeenCalled()
        })

        it('should ensure project modifications are always wrapped in a transaction', async () => {
            const spy = vi.spyOn(mockStudio.project.editing, 'modify')
            await appControl.addTrack("synth", "Transactional")
            expect(spy).toHaveBeenCalled()
        })
    })

    describe('Network Resilience (Fault Injection)', () => {
        it('should display an error card when the AI provider fails (e.g. 500)', async () => {
            // Need OdieService for this integration test
            const { OdieService } = await import('../OdieService')
            const odie = new OdieService()

            // Mock the provider to throw
            const mockProvider = {
                id: 'fail-ai',
                configure: vi.fn(),
                streamChat: vi.fn().mockImplementation(() => {
                    throw new Error("Failed to fetch (Internal Server Error 500)")
                })
            }

            vi.spyOn(odie.ai, 'getActiveProvider').mockReturnValue(mockProvider as any)
            vi.spyOn(odie.ai, 'getConfig').mockReturnValue({ apiKey: 'mock-key' } as any)

            await odie.sendMessage("Help")

            const messages = odie.messages.getValue()
            const lastMsg = messages[messages.length - 1]

            // Verify it caught the error and rendered the error card
            expect(lastMsg.role).toBe('model')
            expect(lastMsg.content).toContain('error_card')
            expect(lastMsg.content).toContain('Connection Failed')
        })
    })
})
