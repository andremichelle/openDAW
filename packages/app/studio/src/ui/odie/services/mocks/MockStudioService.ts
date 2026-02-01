
import { vi } from 'vitest'
import { DefaultObservableValue } from "@opendaw/lib-std"

/**
 * A robust mock for the StudioService used in Odie tests.
 * Provides fake tracks, transport control, and engine state.
 */
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
    private _fakeAdapters: any[] = []

    readonly project = {
        rootBoxAdapter: {
            audioUnits: {
                adapters: () => this._fakeAdapters
            },
            audioBusses: {
                adapters: () => []
            }
        },
        api: {
            createInstrument: vi.fn(),
            createNoteClip: vi.fn(),
            createNoteClipReal: (start: number, end: number) => {
                return {
                    position: new DefaultObservableValue(start),
                    duration: new DefaultObservableValue(end - start),
                    optCollection: {
                        unwrap: () => ({
                            createEvent: vi.fn(),
                            asArray: () => []
                        })
                    }
                }
            },
            createAudioTrack: vi.fn()
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
            panning: new DefaultObservableValue(0.0),
            mute: new DefaultObservableValue(false),
            solo: new DefaultObservableValue(false),
            isAttached: () => true,
        }

        const fakeAdapter: any = {
            label: name,
            type: 'instrument',
            labelField: { getValue: () => name },
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
                solo: fakeBox.solo,
                cutoff: {
                    getValue: () => 0.5,
                    setValue: vi.fn(),
                    minValue: 0,
                    maxValue: 1
                }
            },
            audioEffects: {
                adapters: () => []
            },
            midiEffects: {
                adapters: () => []
            },
            inputAdapter: {
                nonEmpty: () => true,
                isEmpty: () => false,
                unwrap: () => null, // Will be set in next line
                match: (cases: any) => cases.some(fakeAdapter)
            },
            regions: {
                collection: {
                    asArray: () => [] // Start empty, tests can push here
                }
            }
        }
        // Recursive: findFirstTrack(fakeAdapter) -> fakeAdapter
        fakeAdapter.tracks = [fakeAdapter]

        // Recursive reference for testing
        fakeAdapter.inputAdapter.unwrap = () => fakeAdapter

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
        this.project.api.createAudioTrack.mockReset()

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

    readonly odieEvents = {
        notify: vi.fn()
    }
}

export const mockStudio = new MockStudioService()
