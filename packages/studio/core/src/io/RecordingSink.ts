import {Exec, int, Option, Procedure, Terminable, UUID} from "@opendaw/lib-std"
import {AudioData} from "@opendaw/lib-dsp"

// receives an input from the moment it was prepared, frame 0 stamped in audio context time
export interface RecordingSink extends Terminable {
    readonly uuid: UUID.Bytes
    get firstQuantumTime(): Option<number>
    get numberOfFrames(): int
    // keeps the first frames and saves the file once they arrived
    limit(count: int): void
    setFillLength(value: int): void
    set onSaved(callback: Exec)
    onFailed?: Procedure<RecordingSink.Failure>
    // stops feeding the sink
    disconnect(): void
}

export namespace RecordingSink {
    export type Failure = { readonly error: unknown, readonly audio: AudioData }
}
