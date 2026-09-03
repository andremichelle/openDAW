// Detects the start of a recording from the transport's recording flag as the engine state carries it
// after each render. The engine serializes the flag only in `render`, so a command that ends the
// recording followed by one that starts the next, both handled before the next quantum, leaves the flag
// at 1 across two consecutive reads and the new start has no falling edge to follow. The command paths
// that end a recording call `reset` so the next quantum that reads the flag counts as a start.
export class RecordingStartEdge {
    #wasRecording: boolean = false

    // True once per recording: on the first `true` since the last `false` or `reset`.
    observe(isRecording: boolean): boolean {
        const started = isRecording && !this.#wasRecording
        this.#wasRecording = isRecording
        return started
    }

    // The recording ended by command (stop, stopRecording) rather than in a render.
    reset(): void {this.#wasRecording = false}
}
