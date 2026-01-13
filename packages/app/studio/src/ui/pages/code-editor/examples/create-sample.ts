import {InaccessibleProperty} from "@moises-ai/lib-std"
import {Api, AudioPlayback} from "@moises-ai/studio-scripting"
import {AudioData, dbToGain} from "@moises-ai/lib-dsp"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// openDAW script editor (very early preview - under heavy construction)

export {}

const numberOfFrames = sampleRate * 3 // three seconds of audio
const f0 = 200.0
const f1 = 4000.0
const gain = dbToGain(-6.0)

const audioData = AudioData.create(sampleRate, numberOfFrames, 1)
const frames = audioData.frames[0]

for (let i = 0, phase = 0.0; i < numberOfFrames; i++) {
    frames[i] = Math.sin(phase * Math.PI * 2.0) * gain
    const t = i / numberOfFrames
    const freq = f0 * Math.pow(f1 / f0, 1.0 - Math.abs(2.0 * t - 1.0)) // up and down chirp
    phase += freq / sampleRate
}

const sample = await openDAW.addSample(audioData, "Chirp 200-4000Hz")

const project = openDAW.newProject("Test Audio")
const tapeUnit = project.addInstrumentUnit("Tape")
const audioTrack = tapeUnit.addAudioTrack()
audioTrack.addRegion(sample, {playback: AudioPlayback.NoWarp, duration: numberOfFrames / sampleRate})
project.openInStudio()
