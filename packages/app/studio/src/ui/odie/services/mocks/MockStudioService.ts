
import { vi } from 'vitest'
import { DefaultObservableValue } from "@opendaw/lib-std"


// Mock Types needed for the interface
// Mock Types needed for the interface
interface MockAdapter {
    box: {
        isAttached: () => boolean
    } & any
    input: {
        label: {
            unwrapOrElse: (def: string) => string
            getValue: () => string
        }
    }
}

export class MockStudioService {

    // --- TRANSPORT MOCK ---
    readonly transport = {
        loop: new DefaultObservableValue<boolean>(false)
    } as const

    // --- ENGINE MOCK ---
    readonly engine = {
        play: vi.fn(),
        stop: vi.fn(),
        prepareRecordingState: vi.fn(),
        isPlaying: new DefaultObservableValue(false),
        isRecording: new DefaultObservableValue(false),
        position: new DefaultObservableValue(0),
    }

    // --- PROJECT MOCK ---
    private _fakeAdapters: MockAdapter[] = []

    readonly project = {
        rootBoxAdapter: {
            audioUnits: {
                adapters: () => this._fakeAdapters
            }
        },
        api: {
            createInstrument: vi.fn(),
            createNoteClip: vi.fn()
        },
        editing: {
            modify: (cb: () => void) => cb()
        }
    }

    // Mock Helper: add a fake track
    addFakeTrack(name: string) {
        const fakeBox = {
            label: new DefaultObservableValue(name),
            volume: new DefaultObservableValue(0.0),
            panning: new DefaultObservableValue(0.0), // Renamed from pan
            mute: new DefaultObservableValue(false),
            solo: new DefaultObservableValue(false),
            isAttached: () => true,
        }

        const fakeAdapter: MockAdapter & { namedParameter: any } = {
            box: fakeBox,
            input: {
                label: {
                    unwrapOrElse: () => name,
                    getValue: () => name
                }
            },
            namedParameter: {
                volume: fakeBox.volume,
                pan: fakeBox.panning,
                panning: fakeBox.panning,
                mute: fakeBox.mute,
                solo: fakeBox.solo
            }
        }

        this._fakeAdapters.push(fakeAdapter)
        return fakeBox
    }

    // Mock Helper: Reset all spies
    reset() {
        this.engine.play.mockReset()
        this.engine.stop.mockReset()
        this.engine.prepareRecordingState.mockReset()
        this.project.api.createInstrument.mockReset()
        this.project.api.createNoteClip.mockReset()

        // Reset State
        this.transport.loop.setValue(false)
        this.engine.isPlaying.setValue(false)
        this.engine.isRecording.setValue(false)
        this.engine.position.setValue(0)

        // Clear Tracks
        this._fakeAdapters = []
    }

    // Helper to simulate "hasProfile"
    get hasProfile() { return true }
}

export const mockStudio = new MockStudioService()
