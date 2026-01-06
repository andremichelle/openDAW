import { StudioService } from "../../../service/StudioService"


/**
 * OdieTransport Facade
 * --------------------
 * Encapsulates all Transport and Timeline operations for Odie.
 * providing a strict, type-safe API over the raw Engine and Project state.
 */
export class OdieTransport {
    constructor(private readonly studio: StudioService) { }

    // --- State Getters ---

    get isPlaying(): boolean {
        return this.studio.engine.isPlaying.getValue()
    }

    get isRecording(): boolean {
        return this.studio.engine.isRecording.getValue()
    }

    /** Current Playhead Position in Pars (PPQN / 4 ?) or Raw PPQN? 
     *  StudioEngine usually exposes this in seconds or PPQN depending on implementation.
     *  Ref: OdieAppControl generic usage implies consistent units.
     */
    get position(): number {
        return this.studio.engine.position.getValue()
    }

    // --- Direct Actions ---

    play(): void {
        if (!this.isPlaying) {
            this.studio.engine.play()
        }
    }

    stop(): void {
        this.studio.engine.stop(false)
    }

    record(countIn: boolean = true): void {
        if (!this.isRecording) {
            this.studio.engine.prepareRecordingState(countIn)
            this.studio.engine.play()
        }
    }

    stopRecording(): void {
        if (this.isRecording) {
            this.studio.engine.stopRecording()
        }
    }

    setLoop(enabled: boolean): void {
        this.studio.transport.loop.setValue(enabled)
    }

    // --- Timeline Configuration ---

    /**
     * Sets the Project BPM.
     * Returns true if successful, false if no project or invalid range.
     */
    setBpm(bpm: number): boolean {
        if (!this.studio.hasProfile) return false

        // Strict Range Validation
        if (bpm < 20 || bpm > 999) {
            console.warn(`[OdieTransport] BPM ${bpm} out of valid range (20-999). Rejecting.`)
            return false
        }

        try {
            this.studio.project.editing.modify(() => {
                this.studio.project.timelineBox.bpm.setValue(bpm)
            })
            // Verification
            return Math.abs(this.studio.project.timelineBox.bpm.getValue() - bpm) < 0.01
        } catch (e) {
            console.error("[OdieTransport] Failed to set BPM", e)
            return false
        }
    }

    /**
     * Sets the Project Time Signature.
     * Returns true if successful.
     */
    setTimeSignature(numerator: number, denominator: number): boolean {
        if (!this.studio.hasProfile) return false

        // Range Safety
        const n = Math.max(1, Math.min(numerator, 32))
        const d = Math.max(1, Math.min(denominator, 32))

        try {
            const signature = this.studio.project.timelineBox.signature
            this.studio.project.editing.modify(() => {
                signature.nominator.setValue(n)
                signature.denominator.setValue(d)
            })
            return signature.nominator.getValue() === n &&
                signature.denominator.getValue() === d
        } catch (e) {
            console.error("[OdieTransport] Failed to set Time Signature", e)
            return false
        }
    }
}
