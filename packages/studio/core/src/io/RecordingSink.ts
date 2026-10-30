import {Exec, int, Option, Terminable, UUID} from "@opendaw/lib-std"

// receives an input from the moment it was prepared, frame 0 stamped in audio context time
export interface RecordingSink extends Terminable {
    readonly uuid: UUID.Bytes
    get firstQuantumTime(): Option<number>
    get numberOfFrames(): int
    // keeps the first frames and saves the file once they arrived
    limit(count: int): void
    setFillLength(value: int): void
    set onSaved(callback: Exec)
    // stops feeding the sink
    disconnect(): void
}
