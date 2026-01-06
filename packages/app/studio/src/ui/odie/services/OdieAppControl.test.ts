
import { describe, it, expect, beforeEach } from 'vitest'
import { mockStudio } from './mocks/MockStudioService'
import { OdieAppControl } from './OdieAppControl'
import { StudioService } from '@/service/StudioService'

describe('OdieAppControl (The Nervous System)', () => {
    let odie: OdieAppControl

    beforeEach(() => {
        mockStudio.reset()
        // Cast the mock to the real type for the test (Simulator Pattern)
        odie = new OdieAppControl(mockStudio as unknown as StudioService)
    })

    describe('The Heart (Transport)', () => {
        it('should trigger PLAY when requested', () => {
            // Act
            odie.play()

            // Assert
            expect(mockStudio.engine.play).toHaveBeenCalled()
        })

        it('should NOT trigger PLAY if already playing', () => {
            // Arrange
            mockStudio.engine.isPlaying.setValue(true)

            // Act
            odie.play()

            // Assert
            expect(mockStudio.engine.play).not.toHaveBeenCalled()
        })

        it('should trigger STOP when requested', () => {
            // Act
            odie.stop()

            // Assert
            expect(mockStudio.engine.stop).toHaveBeenCalledWith(false)
        })

        it('should toggle LOOP', () => {
            odie.setLoop(true)
            expect(mockStudio.transport.loop.getValue()).toBe(true)
        })
    })

    describe('The Hands (Mixer)', () => {
        it('should find a track and set VOLUME', async () => {
            // Arrange: Simulator setup
            const track = mockStudio.addFakeTrack("Kick")

            // Act
            const result = await odie.setVolume("Kick", -3.0)

            // Assert
            expect(result.success).toBe(true)
            expect(track.volume.getValue()).toBe(-3.0)
        })

        it('should fail cleanly if track NOT found', async () => {
            const result = await odie.setVolume("Ghost", -10.0)
            expect(result.success).toBe(false)
        })

        it('should clamp VOLUME > 6.0', async () => {
            const track = mockStudio.addFakeTrack("Loud")
            await odie.setVolume("Loud", 20.0)
            expect(track.volume.getValue()).toBe(6.0)
        })

        it('should set PAN', async () => {
            const track = mockStudio.addFakeTrack("Snare")
            await odie.setPan("Snare", -0.5)
            expect(track.panning.getValue()).toBe(-0.5)
        })

        it('should clamp PAN', async () => {
            const track = mockStudio.addFakeTrack("Pad")
            await odie.setPan("Pad", -2.0)
            expect(track.panning.getValue()).toBe(-1.0)
        })

        it('should MUTE and SOLO', async () => {
            const track = mockStudio.addFakeTrack("Bass")

            await odie.mute("Bass", true)
            expect(track.mute.getValue()).toBe(true)

            await odie.solo("Bass", true)
            expect(track.solo.getValue()).toBe(true)
        })
    })

    describe('The Eyes (Arrangement)', () => {
        it('should LIST tracks', () => {
            mockStudio.addFakeTrack("Voice")
            mockStudio.addFakeTrack("Guitar")

            const list = odie.listTracks()
            expect(list).toContain("Voice")
            expect(list).toContain("Guitar")
            expect(list.length).toBe(2)
        })

        it('should ADD a Synth Track', async () => {
            const result = await odie.addTrack('synth', "My Hero")
            expect(result).toBe(true)
            expect(mockStudio.project.api.createInstrument).toHaveBeenCalled()
            // We could check arguments if we mocked Imports,
            // but for now we verify the API method was called.
        })

        it('should ADD a Drum Track', async () => {
            const result = await odie.addTrack('drums', "Beat")
            expect(result).toBe(true)
            expect(mockStudio.project.api.createInstrument).toHaveBeenCalled()
        })
    })

})
