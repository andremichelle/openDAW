import {Arrays, assert, int, panic, Procedure} from "@opendaw/lib-std"

export namespace RingBuffer {
    export interface Config {
        sab: SharedArrayBuffer
        numChunks: int
        numberOfChannels: int
        bufferSize: int
    }

    export interface Writer {write(channels: ReadonlyArray<Float32Array>): void}

    export interface Reader {stop(): void}

    // The reader drains the ring on a dedicated worker that blocks on `Atomics.wait` (woken by the writer's
    // `Atomics.notify`). This avoids the main-thread `setTimeout` polling that Chrome throttles to ~1s in hidden
    // tabs, which used to overrun the ring (~0.37s) and silently drop recorded audio. Drained chunks are posted
    // back (transferred) so the caller's `append` still runs on the main thread. See issue #290.
    export const reader = (config: Config, append: Procedure<Array<Float32Array>>): Reader => {
        const code = `
            onmessage = (event) => {
                const {sab, numChunks, numberOfChannels, bufferSize} = event.data
                const pointers = new Int32Array(sab, 0, 2)
                const audio = new Float32Array(sab, 8)
                const chunkFloats = numberOfChannels * bufferSize
                while (true) {
                    let readPtr = Atomics.load(pointers, 1)
                    let writePtr = Atomics.load(pointers, 0)
                    if (readPtr === writePtr) {
                        Atomics.wait(pointers, 0, writePtr)
                        writePtr = Atomics.load(pointers, 0)
                    }
                    const batch = []
                    const transfer = []
                    while (readPtr !== writePtr) {
                        const offset = readPtr * chunkFloats
                        const channels = []
                        for (let channel = 0; channel < numberOfChannels; channel++) {
                            const start = offset + channel * bufferSize
                            const frames = audio.slice(start, start + bufferSize)
                            channels.push(frames)
                            transfer.push(frames.buffer)
                        }
                        readPtr = (readPtr + 1) % numChunks
                        Atomics.store(pointers, 1, readPtr)
                        batch.push(channels)
                    }
                    postMessage(batch, transfer)
                }
            }
        `
        const url = URL.createObjectURL(new Blob([code], {type: "application/javascript"}))
        const worker = new Worker(url)
        worker.onmessage = (event: MessageEvent) => {
            const batch = event.data as Array<Array<Float32Array>>
            for (const channels of batch) {append(channels)}
        }
        worker.postMessage(config)
        return {
            stop: () => {
                worker.terminate()
                URL.revokeObjectURL(url)
            }
        }
    }

    export const writer = ({sab, numChunks, numberOfChannels, bufferSize}: Config): Writer => {
        const pointers = new Int32Array(sab, 0, 2)
        const audio = new Float32Array(sab, 8)
        return Object.freeze({
            write: (channels: ReadonlyArray<Float32Array>): void => {
                if (channels.length !== numberOfChannels) {
                    // We ignore this. This can happen in the worklet setup phase.
                    return
                }
                for (const channel of channels) {
                    if (channel.length !== bufferSize) {
                        return panic("Each channel buffer must contain 'bufferSize' samples")
                    }
                }
                const writePtr = Atomics.load(pointers, 0)
                const offset = writePtr * numberOfChannels * bufferSize
                channels.forEach((channel, index) => audio.set(channel, offset + index * bufferSize))
                Atomics.store(pointers, 0, (writePtr + 1) % numChunks)
                Atomics.notify(pointers, 0)
            }
        })
    }
}

export const mergeChunkPlanes = (chunks: ReadonlyArray<ReadonlyArray<Float32Array>>,
                                 bufferSize: int,
                                 maxFrames: int = Number.MAX_SAFE_INTEGER): ReadonlyArray<Float32Array> => {
    if (chunks.length === 0) {return Arrays.empty()}
    const numChannels = chunks[0].length
    const numFrames = Math.min(bufferSize * chunks.length, maxFrames)
    return Arrays.create(channelIndex => {
        const outChannel = new Float32Array(numFrames)
        chunks.forEach((recordedChannels, chunkIndex) => {
            if (recordedChannels.length !== numChannels) {return panic()}
            const recordedChannel = recordedChannels[channelIndex]
            assert(recordedChannel.length === bufferSize, "Invalid length")
            const remaining = numFrames - chunkIndex * bufferSize
            assert(remaining > 0, "Invalid remaining")
            outChannel.set(remaining < bufferSize
                ? recordedChannel.slice(0, remaining)
                : recordedChannel, chunkIndex * bufferSize)
        })
        return outChannel
    }, numChannels)
}