import {InaccessibleProperty} from "@moises-ai/lib-std"
import {Api} from "@moises-ai/studio-scripting"
import {Interpolation, PPQN} from "@moises-ai/lib-dsp"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// openDAW script editor (very early preview - under heavy construction)
// Stress Test - Complex Multi-Track Production
const project = openDAW.newProject("Ultimate Complexity Test")
project.bpm = 140.0
project.timeSignature = {numerator: 7, denominator: 8} // Odd time signature
project.output.volume = -3.0

// ========== ROUTING SETUP ==========

// Master group for all instruments
const masterGroup = project.addGroupUnit({label: "Master Bus"})
masterGroup.volume = -2.0
masterGroup.panning = 0.0

// Sub-groups
const synthGroup = project.addGroupUnit({label: "Synths"})
synthGroup.output = masterGroup
synthGroup.volume = -1.0

const rhythmGroup = project.addGroupUnit({label: "Rhythm"})
rhythmGroup.output = masterGroup
rhythmGroup.volume = 0.0

// Auxiliary effects
const delayFx = project.addAuxUnit({label: "Delay"})
delayFx.addAudioEffect("delay", {
    delay: 6, // 1/8 note
    feedback: 0.6,
    cross: 0.3,
    wet: 0.8,
    dry: 0.0
})
delayFx.output = masterGroup

const slapbackDelay = project.addAuxUnit({label: "Slapback"})
slapbackDelay.addAudioEffect("delay", {
    delay: 10, // 1/16 note
    feedback: 0.2,
    wet: 1.0,
    dry: 0.0
})
slapbackDelay.output = masterGroup

// ========== BASS SYNTH ==========
const bass = project.addInstrumentUnit("Vaporisateur")
bass.output = rhythmGroup
bass.volume = -6.0
bass.panning = 0.0

// Bass MIDI effects chain
const bassOctaveDown = bass.addMIDIEffect("pitch", {octaves: -2, label: "Sub Bass"})
bass.addMIDIEffect("pitch", {cents: -5, label: "Detune"})

// Bass send to slapback
bass.addSend(slapbackDelay, {amount: -12.0, pan: 0.0, mode: "post"})

// Bass note pattern (complex rhythm in 7/8)
{
    const track = bass.addNoteTrack({enabled: true})
    const region = track.addRegion({
        position: 0,
        duration: PPQN.Bar * 8,
        loopDuration: PPQN.Bar * 2,
        label: "Bass Pattern"
    })

    const eighth = PPQN.Bar / 8
    const sixteenth = PPQN.SemiQuaver

    // 7/8 bass pattern
    const bassPattern = [
        {t: 0, p: 36, d: eighth * 2, v: 0.9},
        {t: eighth * 2, p: 36, d: eighth, v: 0.7},
        {t: eighth * 3, p: 38, d: sixteenth, v: 0.6},
        {t: eighth * 3 + sixteenth, p: 36, d: sixteenth, v: 0.7},
        {t: eighth * 4, p: 41, d: eighth, v: 0.8},
        {t: eighth * 5, p: 36, d: eighth, v: 0.85},
        {t: eighth * 6, p: 38, d: eighth, v: 0.75}
    ]

    bassPattern.forEach(note => {
        region.addEvent({
            position: note.t,
            pitch: note.p,
            duration: note.d,
            velocity: note.v
        })
    })
}

// Bass octave automation
{
    const track = bass.addValueTrack(bassOctaveDown, "octaves")
    const region = track.addRegion({
        duration: PPQN.Bar * 8,
        loopDuration: PPQN.Bar * 4
    })

    region.addEvent({position: 0, value: 0.0, interpolation: Interpolation.None}) // -2 octaves
    region.addEvent({position: PPQN.Bar * 2, value: 0.5, interpolation: Interpolation.Linear}) // -1 octave
    region.addEvent({position: PPQN.Bar * 4, value: 0.0}) // back to -2
}

// ========== LEAD SYNTH ==========
const lead = project.addInstrumentUnit("Nano")
lead.output = synthGroup
lead.volume = -9.0
lead.panning = 0.2

lead.addMIDIEffect("pitch", {octaves: 1, cents: 7, label: "Octave Up Detune"})
lead.addSend(delayFx, {amount: -9.0, pan: -0.5, mode: "post"})

// Lead melody with multiple regions
{
    const track = lead.addNoteTrack({enabled: true})

    // First phrase
    const region1 = track.addRegion({
        position: PPQN.Bar * 2,
        duration: PPQN.Bar * 4,
        label: "Lead Phrase A"
    })

    const quarter = PPQN.Bar / 4
    const melody1 = [
        {t: 0, p: 72, d: quarter * 3, v: 0.8},
        {t: quarter * 3, p: 74, d: quarter, v: 0.75},
        {t: PPQN.Bar, p: 76, d: quarter * 2, v: 0.85},
        {t: PPQN.Bar + quarter * 2, p: 74, d: quarter, v: 0.7},
        {t: PPQN.Bar + quarter * 3, p: 72, d: quarter, v: 0.75},
        {t: PPQN.Bar * 2, p: 69, d: PPQN.Bar * 2, v: 0.9}
    ]

    melody1.forEach(note => {
        region1.addEvent({
            position: note.t,
            pitch: note.p,
            duration: note.d,
            velocity: note.v,
            cents: Math.random() * 10 - 5 // Slight random detune
        })
    })

    // Second phrase (mirror of first)
    track.addRegion({
        position: PPQN.Bar * 6,
        duration: PPQN.Bar * 4,
        label: "Lead Phrase B",
        mirror: region1
    })
}

// Lead panning automation (complex curve)
{
    const track = lead.addValueTrack(lead, "panning")
    const region = track.addRegion({
        duration: PPQN.Bar * 16,
        loopDuration: PPQN.Bar * 4
    })

    region.addEvent({position: 0, value: 0.7, interpolation: Interpolation.Curve(0.8)})
    region.addEvent({position: PPQN.Bar, value: 0.3, interpolation: Interpolation.Curve(0.2)})
    region.addEvent({position: PPQN.Bar * 2, value: 0.6, interpolation: Interpolation.Curve(0.5)})
    region.addEvent({position: PPQN.Bar * 3, value: 0.4, interpolation: Interpolation.Curve(0.7)})
    region.addEvent({position: PPQN.Bar * 4, value: 0.7})
}

// ========== PAD SYNTH ==========
const pad = project.addInstrumentUnit("Vaporisateur")
pad.output = synthGroup
pad.volume = -12.0
pad.panning = -0.1
pad.addSend(delayFx, {amount: -15.0, pan: 0.8, mode: "post"})

// Pad chords (long sustained)
{
    const track = pad.addNoteTrack({enabled: true})
    const region = track.addRegion({
        position: 0,
        duration: PPQN.Bar * 16,
        label: "Pad Chords"
    })

    // Complex chord progression
    const chords = [
        {pos: 0, notes: [48, 52, 55, 60, 64], dur: PPQN.Bar * 4},
        {pos: PPQN.Bar * 4, notes: [45, 48, 52, 57, 60], dur: PPQN.Bar * 4},
        {pos: PPQN.Bar * 8, notes: [43, 47, 50, 55, 59], dur: PPQN.Bar * 4},
        {pos: PPQN.Bar * 12, notes: [50, 53, 57, 62, 65], dur: PPQN.Bar * 4}
    ]

    chords.forEach(chord => {
        chord.notes.forEach((pitch, idx) => {
            region.addEvent({
                position: chord.pos,
                pitch: pitch,
                duration: chord.dur - 100,
                velocity: 0.5 + (idx * 0.05)
            })
        })
    })
}

// Pad volume swells
{
    const track = pad.addValueTrack(pad, "volume")
    const region = track.addRegion({
        duration: PPQN.Bar * 16,
        loopDuration: PPQN.Bar * 4
    })

    region.addEvent({position: 0, value: 0.1, interpolation: Interpolation.Curve(0.3)})
    region.addEvent({position: PPQN.Bar * 2, value: 0.6, interpolation: Interpolation.Curve(0.7)})
    region.addEvent({position: PPQN.Bar * 4, value: 0.1})
}

// ========== ARPEGGIO SYNTH ==========
const arp = project.addInstrumentUnit("Playfield")
arp.output = synthGroup
arp.volume = -10.0
arp.panning = -0.3

const arpPitch = arp.addMIDIEffect("pitch", {octaves: 2, label: "High Octave"})
arp.addSend(delayFx, {amount: -6.0, pan: -0.8, mode: "post"})

// Fast arpeggios
{
    const track = arp.addNoteTrack({enabled: true})
    const region = track.addRegion({
        position: PPQN.Bar * 4,
        duration: PPQN.Bar * 8,
        loopDuration: PPQN.Bar * 2,
        label: "Arp Pattern"
    })

    const sixteenth = PPQN.SemiQuaver
    const arpNotes = [60, 64, 67, 72, 67, 64]

    for (let bar = 0; bar < 2; bar++) {
        for (let i = 0; i < 16; i++) {
            const noteIndex = i % arpNotes.length
            region.addEvent({
                position: bar * PPQN.Bar + i * sixteenth,
                pitch: arpNotes[noteIndex],
                duration: sixteenth * 0.7,
                velocity: i % 4 === 0 ? 0.8 : 0.6
            })
        }
    }
}

// Arp octave modulation
{
    const track = arp.addValueTrack(arpPitch, "octaves")
    const region = track.addRegion({
        duration: PPQN.Bar * 8,
        loopDuration: PPQN.Bar * 2
    })

    region.addEvent({position: 0, value: 1.0, interpolation: Interpolation.None}) // 2 octaves
    region.addEvent({position: PPQN.Bar, value: 0.5, interpolation: Interpolation.None}) // 1 octave
    region.addEvent({position: PPQN.Bar * 2, value: 1.0})
}

// ========== PERCUSSION SYNTH ==========
const drums = project.addInstrumentUnit("Nano")
drums.output = rhythmGroup
drums.volume = -4.0
drums.panning = 0.0
drums.addSend(slapbackDelay, {amount: -18.0, pan: 0.3, mode: "post"})

// Drum pattern
{
    const track = drums.addNoteTrack({enabled: true})
    const region = track.addRegion({
        position: 0,
        duration: PPQN.Bar * 16,
        loopDuration: PPQN.Bar,
        label: "Drum Loop"
    })

    const sixteenth = PPQN.SemiQuaver
    const eighth = PPQN.Bar / 8

    // Kick pattern (7/8 time)
    const kickPositions = [0, eighth * 2, eighth * 4, eighth * 6]
    kickPositions.forEach((pos: number) => {
        region.addEvent({position: pos, pitch: 36, duration: sixteenth, velocity: 0.95})
    })

    // Snare pattern
    const snarePositions = [eighth * 2, eighth * 5]
    snarePositions.forEach((pos: number) => {
        region.addEvent({position: pos, pitch: 38, duration: sixteenth, velocity: 0.9})
    })

    // Hi-hats (every 16th)
    for (let i = 0; i < 14; i++) {
        region.addEvent({
            position: i * sixteenth,
            pitch: 42,
            duration: sixteenth * 0.5,
            velocity: i % 4 === 0 ? 0.8 : 0.5
        })
    }
}

// ========== MASTER GROUP AUTOMATION ==========
{
    const track = masterGroup.addValueTrack(masterGroup, "volume")
    const region = track.addRegion({
        duration: PPQN.Bar * 16
    })

    // Build-up and breakdown
    region.addEvent({position: 0, value: 0.3, interpolation: Interpolation.Curve(0.2)})
    region.addEvent({position: PPQN.Bar * 4, value: 0.7, interpolation: Interpolation.Linear})
    region.addEvent({position: PPQN.Bar * 8, value: 0.9, interpolation: Interpolation.Curve(0.8)})
    region.addEvent({position: PPQN.Bar * 12, value: 0.4, interpolation: Interpolation.Curve(0.3)})
    region.addEvent({position: PPQN.Bar * 15, value: 0.1})
}

// ========== DELAY FEEDBACK AUTOMATION ==========
{
    const delayEffect = delayFx.addAudioEffect("delay")
    const track = delayFx.addValueTrack(delayEffect, "feedback")
    const region = track.addRegion({
        duration: PPQN.Bar * 16,
        loopDuration: PPQN.Bar * 8
    })

    region.addEvent({position: 0, value: 0.4, interpolation: Interpolation.Linear})
    region.addEvent({position: PPQN.Bar * 4, value: 0.8, interpolation: Interpolation.Curve(0.6)})
    region.addEvent({position: PPQN.Bar * 6, value: 0.95, interpolation: Interpolation.Curve(0.9)})
    region.addEvent({position: PPQN.Bar * 7, value: 0.3})
}

// ========== MUTE/SOLO PATTERNS ==========
// Mute bass for breakdown
bass.mute = false
lead.solo = false

project.openInStudio()