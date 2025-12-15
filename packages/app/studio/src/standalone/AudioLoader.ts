import {Peaks} from "@opendaw/lib-fusion"

export class AudioLoader {
    static async loadAudio(path: string): Promise<{ buffer: AudioBuffer, peaks: Peaks }> {
        // In Electron, we can use file:// protocol or standard fetch if security is disabled
        // We enabled file access in main.ts
        const response = await fetch(`file://${path}`)
        const arrayBuffer = await response.arrayBuffer()

        const audioContext = new AudioContext()
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
        audioContext.close()

        const peaks = Peaks.create(audioBuffer)

        return { buffer: audioBuffer, peaks }
    }
}
