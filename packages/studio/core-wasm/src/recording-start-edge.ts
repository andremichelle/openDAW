// the flag only changes in render, so a stop and a restart between two renders leave it at 1: stop paths reset the edge
export class RecordingStartEdge {
    #wasRecording: boolean = false

    observe(isRecording: boolean): boolean {
        const started = isRecording && !this.#wasRecording
        this.#wasRecording = isRecording
        return started
    }

    reset(): void {this.#wasRecording = false}
}
