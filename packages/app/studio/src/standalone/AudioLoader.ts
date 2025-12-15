import {Peaks, SamplePeaks} from "@opendaw/lib-fusion"
import {Arrays, Float16, int} from "@opendaw/lib-std"

export class AudioLoader {
    static async loadAudio(path: string): Promise<{ buffer: AudioBuffer, peaks: Peaks }> {
        const response = await fetch(`file://${path}`)
        const arrayBuffer = await response.arrayBuffer()

        const audioContext = new AudioContext()
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
        audioContext.close()

        const peaks = this.generatePeaks(audioBuffer)

        return { buffer: audioBuffer, peaks }
    }

    private static generatePeaks(buffer: AudioBuffer): Peaks {
        const numFrames = buffer.length
        const numChannels = buffer.numberOfChannels
        const shifts = SamplePeaks.findBestFit(numFrames)

        // Simplified generation (synchronous)
        const [stages, dataOffset] = this.initStages(shifts, numFrames)
        const data: Int32Array[] = Arrays.create(() => new Int32Array(dataOffset), numChannels)
        const minMask = (1 << stages[0].shift) - 1

        for (let channel = 0; channel < numChannels; ++channel) {
            const channelData = data[channel]
            const channelFrames = buffer.getChannelData(channel)
            const states = Arrays.create(() => ({min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, index: 0}), shifts.length)

            let min = Number.POSITIVE_INFINITY
            let max = Number.NEGATIVE_INFINITY
            let position = 0

            for (let i = 0; i < numFrames; ++i) {
                const frame = channelFrames[i]
                min = Math.min(frame, min)
                max = Math.max(frame, max)

                if ((++position & minMask) === 0) {
                    for (let j = 0; j < shifts.length; ++j) {
                        const stage = stages[j]
                        const state = states[j]
                        state.min = Math.min(state.min, min)
                        state.max = Math.max(state.max, max)

                        if ((((1 << stage.shift) - 1) & position) === 0) {
                            // Pack min/max
                            const bits0 = Float16.floatToIntBits(state.min)
                            const bits1 = Float16.floatToIntBits(state.max)
                            channelData[stage.dataOffset + state.index++] = bits0 | (bits1 << 16)

                            state.min = Number.POSITIVE_INFINITY
                            state.max = Number.NEGATIVE_INFINITY
                        }
                    }
                    min = Number.POSITIVE_INFINITY
                    max = Number.NEGATIVE_INFINITY
                }
            }
        }

        return new SamplePeaks(stages, data, numFrames, numChannels)
    }

    private static initStages(shifts: Uint8Array, numFrames: int): [Peaks.Stage[], int] {
        let dataOffset = 0
        const stages = Arrays.create((index: int) => {
            const shift = shifts[index]
            const numPeaks = Math.ceil(numFrames / (1 << shift))
            const stage = new Peaks.Stage(shift, numPeaks, dataOffset)
            dataOffset += numPeaks
            return stage
        }, shifts.length)
        return [stages, dataOffset]
    }
}
