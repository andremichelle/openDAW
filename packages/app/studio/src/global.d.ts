interface FileSystemFileHandle {
    createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>
}

interface FileSystemSyncAccessHandle {
    write(buffer: BufferSource, options?: { at?: number }): number
    read(buffer: BufferSource, options?: { at?: number }): number
    getSize(): number
    truncate(newSize: number): void
    flush(): void
    close(): void
}

interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

type AudioSinkInfo = string | { type: "none" }

// Buffer-underrun statistics (not yet typed in lib.dom).
// https://webaudio.github.io/web-audio-api/#AudioPlaybackStats
interface AudioPlaybackStats {
    readonly underrunDuration: number
    readonly underrunEvents: number
    readonly totalDuration: number
    readonly averageLatency: number
    readonly minimumLatency: number
    readonly maximumLatency: number
    resetLatency(): void
    toJSON(): object
}

interface AudioContext {
    setSinkId(id: AudioSinkInfo): Promise<void>
    get sinkId(): AudioSinkInfo
    readonly playbackStats?: AudioPlaybackStats
}