import {InaccessibleProperty} from "@opendaw/lib-std"
import {Api} from "@opendaw/studio-scripting"
import {PPQN} from "@opendaw/lib-dsp"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// Welcome to the openDAW script editor!
// Everything in a project can be created and changed from here. Press "Run" to hear this one.
// Type `project.` or `synth.` to explore what is available.

// A new project at 110 bpm
const project = openDAW.newProject("Hello openDAW")
project.bpm = 110

// A synth on its own track, tweak the sound right away
const synth = project.addInstrumentUnit("Vaporisateur", {label: "Pluck", volume: -9}, {
    cutoff: 2400,
    resonance: 0.4,
    filterEnvelope: 0.6,
    decay: 0.25,
    sustain: 0.1,
    release: 0.4
})

// A send to a reverb, so the plucks get some air
const reverb = project.addAuxUnit({label: "Reverb"})
reverb.addAudioEffect("Reverb", {decay: 0.7, wet: -6})
synth.addSend(reverb, {amount: -12})

// Two bars of notes, looping every bar (all times are in PPQN, PPQN.Bar is one bar)
const region = synth.noteTracks[0].addRegion({duration: PPQN.Bar * 2, loopDuration: PPQN.Bar, label: "Pluck"})

// A minor pentatonic arpeggio, one note per 16th
const scale = [57, 60, 62, 64, 67, 69, 72, 76]
for (let step = 0; step < 16; step++) {
    const rise = step < 8 ? step : 15 - step
    region.addEvent({
        position: step * PPQN.SemiQuaver,
        duration: PPQN.SemiQuaver,
        pitch: scale[rise],
        velocity: step % 4 === 0 ? 1.0 : 0.7
    })
}

// A sustained root underneath
region.addEvent({position: 0, duration: PPQN.Bar, pitch: 45, velocity: 0.6})

// Hand the project over to the studio
project.openInStudio()
