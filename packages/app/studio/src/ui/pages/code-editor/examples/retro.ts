import {InaccessibleProperty} from "@moises-ai/lib-std"
import {Api} from "@moises-ai/studio-scripting"
import {Interpolation, PPQN} from "@moises-ai/lib-dsp"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// openDAW script editor (very early preview - under heavy construction)

// openDAW Beginner Example - Retro Game Music!
// A catchy 4-bar melody with chords and panning
// Composed by Claude.ai

// Create a new project
const project = openDAW.newProject("Retro Game")
project.bpm = 140.0
project.output.volume = -6.0

// ========== DELAY EFFECT ==========
const delay = project.addAuxUnit({label: "Delay"})
delay.addAudioEffect("delay", {
    delay: 6,      // 1/8 note
    feedback: 0.5,
    wet: 0.7
})

// ========== GAME SYNTH ==========
const synth = project.addInstrumentUnit("Vaporisateur")
synth.volume = -9.0
synth.panning = 0.0
synth.addSend(delay, {amount: -12.0})

// ========== MELODY + CHORDS ==========
{
    const track = synth.addNoteTrack({enabled: true})
    const region = track.addRegion({
        position: 0,
        duration: PPQN.Bar * 4,
        label: "Melody & Chords"
    })

    const sixteenth = PPQN.SemiQuaver
    const eighth = PPQN.Bar / 8

    // Chord progression (sustained)
    const chords = [
        // Bar 1: C major
        {position: 0, pitch: 48, duration: PPQN.Bar, velocity: 0.6},
        {position: 0, pitch: 52, duration: PPQN.Bar, velocity: 0.55},
        {position: 0, pitch: 55, duration: PPQN.Bar, velocity: 0.55},

        // Bar 2: A minor
        {position: PPQN.Bar, pitch: 45, duration: PPQN.Bar, velocity: 0.6},
        {position: PPQN.Bar, pitch: 48, duration: PPQN.Bar, velocity: 0.55},
        {position: PPQN.Bar, pitch: 52, duration: PPQN.Bar, velocity: 0.55},

        // Bar 3: F major
        {position: PPQN.Bar * 2, pitch: 41, duration: PPQN.Bar, velocity: 0.6},
        {position: PPQN.Bar * 2, pitch: 45, duration: PPQN.Bar, velocity: 0.55},
        {position: PPQN.Bar * 2, pitch: 48, duration: PPQN.Bar, velocity: 0.55},

        // Bar 4: G major
        {position: PPQN.Bar * 3, pitch: 43, duration: PPQN.Bar, velocity: 0.6},
        {position: PPQN.Bar * 3, pitch: 47, duration: PPQN.Bar, velocity: 0.55},
        {position: PPQN.Bar * 3, pitch: 50, duration: PPQN.Bar, velocity: 0.55}
    ]

    // Melody (bouncy and retro)
    const melody = [
        // Bar 1
        {position: 0, pitch: 72, duration: eighth, velocity: 0.85},
        {position: eighth, pitch: 74, duration: sixteenth, velocity: 0.75},
        {position: eighth + sixteenth, pitch: 72, duration: sixteenth, velocity: 0.75},
        {position: eighth * 2, pitch: 67, duration: eighth, velocity: 0.8},
        {position: eighth * 3, pitch: 69, duration: sixteenth, velocity: 0.75},
        {position: eighth * 3 + sixteenth, pitch: 67, duration: sixteenth, velocity: 0.75},
        {position: eighth * 4, pitch: 64, duration: eighth * 2, velocity: 0.85},
        {position: eighth * 6, pitch: 67, duration: eighth, velocity: 0.8},
        {position: eighth * 7, pitch: 69, duration: eighth, velocity: 0.8},

        // Bar 2
        {position: PPQN.Bar, pitch: 72, duration: eighth * 3, velocity: 0.9},
        {position: PPQN.Bar + eighth * 4, pitch: 69, duration: eighth, velocity: 0.75},
        {position: PPQN.Bar + eighth * 5, pitch: 67, duration: eighth, velocity: 0.75},
        {position: PPQN.Bar + eighth * 6, pitch: 65, duration: eighth * 2, velocity: 0.8},

        // Bar 3
        {position: PPQN.Bar * 2, pitch: 69, duration: sixteenth, velocity: 0.85},
        {position: PPQN.Bar * 2 + sixteenth, pitch: 72, duration: sixteenth, velocity: 0.8},
        {position: PPQN.Bar * 2 + sixteenth * 2, pitch: 74, duration: sixteenth, velocity: 0.8},
        {position: PPQN.Bar * 2 + sixteenth * 3, pitch: 76, duration: sixteenth, velocity: 0.85},
        {position: PPQN.Bar * 2 + eighth * 2, pitch: 77, duration: eighth * 2, velocity: 0.9},
        {position: PPQN.Bar * 2 + eighth * 4, pitch: 76, duration: eighth, velocity: 0.8},
        {position: PPQN.Bar * 2 + eighth * 5, pitch: 74, duration: eighth, velocity: 0.75},
        {position: PPQN.Bar * 2 + eighth * 6, pitch: 72, duration: eighth * 2, velocity: 0.8},

        // Bar 4: Big finish
        {position: PPQN.Bar * 3, pitch: 79, duration: sixteenth, velocity: 0.9},
        {position: PPQN.Bar * 3 + sixteenth, pitch: 77, duration: sixteenth, velocity: 0.85},
        {position: PPQN.Bar * 3 + sixteenth * 2, pitch: 76, duration: sixteenth, velocity: 0.8},
        {position: PPQN.Bar * 3 + sixteenth * 3, pitch: 74, duration: sixteenth, velocity: 0.8},
        {position: PPQN.Bar * 3 + eighth * 2, pitch: 72, duration: eighth * 6, velocity: 0.95}
    ]

    region.addEvents([...chords, ...melody])
}

// ========== PANNING AUTOMATION ==========
{
    const track = synth.addValueTrack(synth, "panning")
    const region = track.addRegion({
        duration: PPQN.Bar * 4
    })

    region.addEvents([
        {position: 0, value: 0.5, interpolation: Interpolation.Linear},
        {position: PPQN.Bar, value: 0.8, interpolation: Interpolation.Linear},
        {position: PPQN.Bar * 2, value: 0.2, interpolation: Interpolation.Linear},
        {position: PPQN.Bar * 3, value: 0.5}
    ])
}

project.openInStudio()