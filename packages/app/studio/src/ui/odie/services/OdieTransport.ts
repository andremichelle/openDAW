import type { StudioService } from "../../../service/StudioService"


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
            if (this.studio.project && typeof this.studio.project.startRecording === 'function') {
                this.studio.project.startRecording(countIn)
            } else {
                // Flashback: If project not ready or method missing, fallback
                this.studio.engine.prepareRecordingState(countIn)
                this.studio.engine.play()
            }
        }
    }

    stopRecording(): void {
        if (this.isRecording) {
            this.studio.engine.stopRecording()
        }
    }

    setLoop(enabled: boolean): void {
        this.studio.transport.setLoop(enabled)
    }

    // --- Timeline Configuration ---

    /**
     * Sets the Project BPM.
     * Returns true if successful, false if no project or invalid range.
     */
    setBpm(bpm: number): boolean {
        if (!this.studio.hasProfile) return false

        // Strict Range & Safety Validation
        // [ANTI-HAL] Protect against LLM returning "fast" (NaN) or Infinity
        if (!Number.isFinite(bpm) || bpm < 20 || bpm > 999) {
            console.warn(`[OdieTransport] BPM ${bpm} is invalid (NaN or out of range 20-999). Rejecting.`)
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

        // Range Safety & NaN Check
        if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
            console.warn(`[OdieTransport] Time Signature ${numerator}/${denominator} contains NaN. Rejecting.`)
            return false
        }

        const n = Math.max(1, Math.min(numerator, 32))
        const allowed = [1, 2, 4, 8, 16, 32]
        if (!allowed.includes(denominator)) {
            console.warn(`[OdieTransport] Denominator ${denominator} is not supported.`)
            return false
        }

        const d = denominator

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
