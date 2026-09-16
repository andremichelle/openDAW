import {InaccessibleProperty} from "@opendaw/lib-std"
import {Api} from "@opendaw/studio-scripting"
import {dbToGain, WavFile} from "@opendaw/lib-dsp"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// Mixdown: renders the current project, normalizes the peak to -1 dB and saves it as a wav file

if (!await openDAW.hasProject()) {
    await openDAW.showInfo("Mixdown", "No project is open. Create or load one first.")
} else {
    const project = await openDAW.getProject()
    const audio = await project.mixdown({sampleRate: 48000})
    let peak = 0.0
    audio.frames.forEach(frame => frame.forEach(value => peak = Math.max(peak, Math.abs(value))))
    if (peak > 0.0) {
        const gain = dbToGain(-1.0) / peak
        audio.frames.forEach(frame => frame.forEach((value, index) => frame[index] = value * gain))
    }
    await openDAW.saveFile(WavFile.encodeFloats(audio), `${project.name}.wav`, "audio/wav")
}
