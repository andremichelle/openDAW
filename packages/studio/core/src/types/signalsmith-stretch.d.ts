declare module "signalsmith-stretch" {
    export type StretchSchedule = {
        // the processor keys segment placement on `outputTime` (falls back to currentTime); the
        // documented `output` field only labels the stored segment, so always pass `outputTime`
        outputTime?: number
        output?: number
        active?: boolean
        input?: number
        rate?: number
        semitones?: number
        tonalityHz?: number
        formantSemitones?: number
        formantCompensation?: boolean
        formantBaseHz?: number
        loopStart?: number
        loopEnd?: number
    }
    export type StretchNode = AudioWorkletNode & {
        inputTime: number
        schedule(change: StretchSchedule): Promise<void>
        start(when?: number): Promise<void>
        stop(when?: number): Promise<void>
        addBuffers(buffers: ReadonlyArray<Float32Array>): Promise<number>
        dropBuffers(toSeconds?: number): Promise<{ start: number, end: number }>
        latency(): Promise<number>
        configure(options: {
            blockMs?: number,
            intervalMs?: number,
            splitComputation?: boolean,
            preset?: "default" | "cheaper"
        }): Promise<void>
        setUpdateInterval(seconds: number, callback?: (seconds: number) => void): Promise<void>
    }
    const SignalsmithStretch: (context: BaseAudioContext, options?: AudioWorkletNodeOptions) => Promise<StretchNode>
    export default SignalsmithStretch
}
