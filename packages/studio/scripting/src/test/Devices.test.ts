import {describe, expect, it} from "vitest"
import {Mixing} from "@opendaw/lib-dsp"
import {createFixture, sample} from "./Fixture"
import {AudioEffects, MIDIEffects} from "../Api"

describe("Devices", () => {
    it("adds every midi effect with defaults", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Vaporisateur")
        const keys: ReadonlyArray<keyof MIDIEffects> = ["Arpeggio", "Pitch", "Velocity", "Zeitgeist", "Spielwerk"]
        keys.forEach((key, index) => {
            const effect = unit.addMIDIEffect(key)
            expect(effect.key).toBe(key)
            expect(effect.index).toBe(index)
            expect(effect.enabled).toBe(true)
            expect(effect.audioUnit).toBe(unit)
        })
        expect(unit.midiEffects.map(effect => effect.key)).toEqual(keys)
        expect(() => unit.addMIDIEffect("Delay" as any)).toThrow(RangeError)
    })

    it("adds every audio effect with defaults", () => {
        const {project} = createFixture()
        const unit = project.addAuxUnit()
        const keys: ReadonlyArray<keyof AudioEffects> = [
            "Autotune", "Compressor", "Convolver", "Crusher", "DattorroReverb", "Delay", "Fold", "Gate", "Maximizer",
            "NeuralAmp", "Revamp", "Reverb", "StereoTool", "Tidal", "Vocoder", "Waveshaper", "Werkstatt",
            "Composite", "StereoSplit", "FrequencySplit"
        ]
        keys.forEach((key, index) => {
            const effect = unit.addAudioEffect(key)
            expect(effect.key).toBe(key)
            expect(effect.index).toBe(index)
            expect(effect.audioUnit).toBe(unit)
        })
        expect(unit.audioEffects.map(effect => effect.key)).toEqual(keys)
        expect(() => unit.addAudioEffect("Pitch" as any)).toThrow(RangeError)
    })

    it("orders, moves and removes effects", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Vaporisateur")
        const delay = unit.addAudioEffect("Delay")
        const reverb = unit.addAudioEffect("Reverb")
        const first = unit.addAudioEffect("Crusher", {}, 0)
        expect(unit.audioEffects).toEqual([first, delay, reverb])
        expect(delay.index).toBe(1)
        reverb.move(0)
        expect(unit.audioEffects.map(effect => effect.key)).toEqual(["Reverb", "Crusher", "Delay"])
        first.move(99)
        expect(unit.audioEffects.map(effect => effect.key)).toEqual(["Reverb", "Delay", "Crusher"])
        reverb.remove()
        expect(unit.audioEffects.map(effect => effect.key)).toEqual(["Delay", "Crusher"])
        expect(delay.index).toBe(0)
        expect(first.index).toBe(1)
        expect(() => reverb.enabled).toThrow()
        delay.label = "Echo"
        delay.enabled = false
        delay.minimized = true
        expect(delay.label).toBe("Echo")
        expect(delay.enabled).toBe(false)
    })

    it("applies and validates effect parameters", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Vaporisateur")
        const delay = unit.addAudioEffect("Delay", {delay: 6, feedback: 0.6, wet: -3, filter: -0.5})
        expect(delay.delay).toBe(6)
        expect(delay.feedback).toBeCloseTo(0.6)
        expect(delay.wet).toBe(-3)
        expect(delay.filter).toBe(-0.5)
        delay.feedback = 4
        expect(delay.feedback).toBe(1)
        delay.wet = 12
        expect(delay.wet).toBe(0)
        delay.wet = Number.NEGATIVE_INFINITY
        expect(delay.wet).toBe(Number.NEGATIVE_INFINITY)
        expect(() => delay.wet = Number.POSITIVE_INFINITY).toThrow(RangeError)
        delay.lfoSpeed = 100
        expect(delay.lfoSpeed).toBe(5)
        const compressor = unit.addAudioEffect("Compressor", {ratio: 4, lookahead: true})
        expect(compressor.ratio).toBe(4)
        expect(compressor.lookahead).toBe(true)
        expect(() => compressor.lookahead = "yes" as any).toThrow(TypeError)
        const fold = unit.addAudioEffect("Fold")
        fold.overSampling = 2
        expect(fold.overSampling).toBe(2)
        expect(() => fold.overSampling = 3 as any).toThrow(RangeError)
        const stereo = unit.addAudioEffect("StereoTool", {panningMixing: Mixing.EqualPower})
        expect(stereo.panningMixing).toBe(Mixing.EqualPower)
        expect(() => stereo.panningMixing = 5 as Mixing).toThrow(RangeError)
        const vocoder = unit.addAudioEffect("Vocoder", {bandCount: 8, modulatorSource: "input"})
        expect(vocoder.bandCount).toBe(8)
        expect(vocoder.modulatorSource).toBe("input")
        expect(() => vocoder.bandCount = 10 as any).toThrow(RangeError)
        expect(() => vocoder.modulatorSource = "sine" as any).toThrow(RangeError)
        const pitch = unit.addMIDIEffect("Pitch", {octaves: -2, semiTones: 7.4})
        expect(pitch.octaves).toBe(-2)
        expect(pitch.semiTones).toBe(7)
        pitch.octaves = -20
        expect(pitch.octaves).toBe(-7)
        const arp = unit.addMIDIEffect("Arpeggio", {mode: 1, rate: 3})
        expect(arp.mode).toBe(1)
        expect(() => arp.mode = 3 as any).toThrow(RangeError)
        arp.octaves = 0
        expect(arp.octaves).toBe(1)
        const zeitgeist = unit.addMIDIEffect("Zeitgeist")
        expect(zeitgeist.groove.duration).toBe(480)
        zeitgeist.groove.amount = 0.3
        expect(zeitgeist.groove.amount).toBeCloseTo(0.3)
        const revamp = unit.addAudioEffect("Revamp", {lowBell: {gain: -3, frequency: 200}})
        expect(revamp.lowBell.gain).toBe(-3)
        expect(revamp.lowBell.frequency).toBe(200)
        expect(revamp.highPass.enabled).toBe(true)
        expect(revamp.highPass.frequency).toBe(40)
        revamp.lowPass.order = 3
        expect(revamp.lowPass.order).toBe(3)
        expect(() => revamp.lowPass.order = 4 as any).toThrow(RangeError)
        const waveshaper = unit.addAudioEffect("Waveshaper", {equation: "tanh(x)"})
        expect(waveshaper.equation).toBe("tanh(x)")
        expect(() => waveshaper.equation = 3 as any).toThrow(TypeError)
        const reverb = unit.addAudioEffect("Reverb")
        expect(reverb.preDelay).toBeCloseTo(0.001)
        const tidal = unit.addAudioEffect("Tidal")
        expect(tidal.depth).toBeCloseTo(0.75)
    })

    it("connects sidechains", () => {
        const {project} = createFixture()
        const kick = project.addInstrumentUnit("Vaporisateur", {label: "Kick"})
        const bass = project.addInstrumentUnit("Nano", {label: "Bass"})
        const compressor = bass.addAudioEffect("Compressor")
        expect(compressor.sideChain).toBeNull()
        compressor.sideChain = kick
        expect(compressor.sideChain).toBe(kick)
        compressor.sideChain = kick.instrument
        expect(compressor.sideChain).toBe(kick.instrument)
        const kickDelay = kick.addAudioEffect("Delay")
        compressor.sideChain = kickDelay
        expect(compressor.sideChain).toBe(kickDelay)
        compressor.sideChain = null
        expect(compressor.sideChain).toBeNull()
        expect(() => compressor.sideChain = {} as any).toThrow(TypeError)
        const gate = bass.addAudioEffect("Gate", {sideChain: kick})
        expect(gate.sideChain).toBe(kick)
        const composite = bass.addAudioEffect("Composite")
        const entry = composite.addEntry()
        const nested = entry.addAudioEffect("Compressor")
        nested.sideChain = composite
        expect(nested.sideChain).toBe(composite)
        expect(nested.audioUnit).toBe(bass)
    })

    it("hosts composites with entries", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Vaporisateur")
        const composite = unit.addAudioEffect("Composite", {dry: -6})
        expect(composite.dry).toBe(-6)
        expect(composite.wet).toBe(0)
        expect(composite.entries.length).toBe(0)
        const wet = composite.addEntry({label: "Wet", gain: -3, pan: 0.5})
        const dry = composite.addEntry()
        expect(composite.entries).toEqual([wet, dry])
        expect(wet.label).toBe("Wet")
        expect(wet.gain).toBe(-3)
        expect(wet.pan).toBe(0.5)
        expect(dry.label).toBe("Entry 2")
        expect(wet.composite).toBe(composite)
        const reverb = wet.addAudioEffect("Reverb")
        expect(wet.audioEffects).toEqual([reverb])
        expect(reverb.audioUnit).toBe(unit)
        wet.remove()
        expect(composite.entries).toEqual([dry])
        expect(dry.index).toBe(0)
        const stereo = unit.addAudioEffect("StereoSplit")
        expect(stereo.entries.map(entry => entry.label)).toEqual(["L", "R"])
        expect(() => stereo.entries[0].remove()).toThrow()
        const split = unit.addAudioEffect("FrequencySplit", {crossover1: 100})
        expect(split.entries.map(entry => entry.label)).toEqual(["Low", "Low Mid", "High Mid", "High"])
        expect(split.crossover1).toBe(100)
        split.entries[3].addAudioEffect("Crusher")
        expect(split.entries[3].audioEffects[0].key).toBe("Crusher")
        const automation = unit.addValueTrack(dry, "gain")
        expect(automation.target).toBe(dry)
    })

    it("declares script parameters and samples from code", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Vaporisateur")
        const werkstatt = unit.addAudioEffect("Werkstatt")
        expect(werkstatt.code).toBe("")
        expect(werkstatt.parameters.length).toBe(0)
        werkstatt.code = [
            "// @label Fuzz",
            "// @param drive 0.5",
            "// @param tone 1000 20 20000 exp Hz",
            "// @sample impulse",
            "class Processor {}"
        ].join("\n")
        expect(werkstatt.label).toBe("Fuzz")
        expect(werkstatt.code.startsWith("// @label Fuzz")).toBe(true)
        expect(werkstatt.parameters.map(parameter => parameter.label)).toEqual(["drive", "tone"])
        expect(werkstatt.parameter("tone").value).toBe(1000)
        expect(werkstatt.parameter("tone").defaultValue).toBe(1000)
        expect(werkstatt.parameter("tone").index).toBe(1)
        werkstatt.parameter("drive").value = 0.9
        expect(werkstatt.parameter("drive").value).toBeCloseTo(0.9)
        expect(werkstatt.samples.map(sample => sample.label)).toEqual(["impulse"])
        expect(werkstatt.sample("impulse").sample).toBeNull()
        const impulse = sample("IR")
        werkstatt.sample("impulse").sample = impulse
        expect(werkstatt.sample("impulse").sample?.uuid).toBe(impulse.uuid)
        expect(() => werkstatt.parameter("bogus")).toThrow(RangeError)
        werkstatt.code = "// @param drive 0.5\nclass Processor {}"
        expect(werkstatt.parameters.map(parameter => parameter.label)).toEqual(["drive"])
        expect(werkstatt.parameter("drive").value).toBeCloseTo(0.9)
        expect(werkstatt.samples.length).toBe(0)
        expect(() => werkstatt.code = "// @param 1 2 3 4 5 6 7\n").toThrow()
        const automation = unit.addValueTrack(werkstatt.parameter("drive"), "value")
        expect(automation.target).toBe(werkstatt.parameter("drive"))
        const apparat = project.addInstrumentUnit("Apparat").instrument
        apparat.code = "// @param level 0.2\nclass Processor {}"
        expect(apparat.parameters[0].label).toBe("level")
        const spielwerk = unit.addMIDIEffect("Spielwerk")
        spielwerk.code = "// @param chance 1\nclass Processor {}"
        expect(spielwerk.parameter("chance").value).toBe(1)
    })

    it("configures samplers", () => {
        const {project} = createFixture()
        const nano = project.addInstrumentUnit("Nano").instrument
        expect(nano.sample).toBeNull()
        const wave = sample("Wave", 3)
        nano.sample = wave
        expect(nano.sample?.name).toBe("Wave")
        nano.release = 20
        expect(nano.release).toBe(8)
        nano.sample = null
        expect(nano.sample).toBeNull()
        const playfield = project.addInstrumentUnit("Playfield").instrument
        expect(playfield.slots.length).toBe(0)
        const kick = playfield.addSample(sample("Kick"), {note: 36, volume: -3, gate: 1})
        const snare = playfield.addSample(sample("Snare"))
        const hat = playfield.addSample(sample("Hat"), {exclude: true})
        expect(kick.note).toBe(36)
        expect(snare.note).toBe(60)
        expect(hat.note).toBe(61)
        expect(kick.volume).toBe(-3)
        expect(kick.gate).toBe(1)
        expect(hat.exclude).toBe(true)
        expect(playfield.slots.map(slot => slot.note)).toEqual([36, 60, 61])
        expect(playfield.slot(36)).toBe(kick)
        expect(playfield.slot(37)).toBeNull()
        expect(kick.sample.name).toBe("Kick")
        expect(kick.playfield).toBe(playfield)
        const replaced = playfield.addSample(sample("Kick 2"), {note: 36})
        expect(playfield.slot(36)).toBe(replaced)
        expect(() => kick.note).toThrow()
        const slotEffect = replaced.addAudioEffect("Delay")
        expect(replaced.audioEffects[0]).toBe(slotEffect)
        expect(slotEffect.audioUnit.kind).toBe("instrument")
        replaced.addMIDIEffect("Pitch")
        expect(replaced.midiEffects.length).toBe(1)
        expect(() => replaced.gate = 3 as any).toThrow(RangeError)
        expect(() => playfield.addSample(sample("Bad"), {note: 200})).not.toThrow()
        expect(playfield.slot(127)).not.toBeNull()
        const soundfont = project.addInstrumentUnit("Soundfont").instrument
        expect(soundfont.file).toBeNull()
        soundfont.file = {uuid: sample().uuid, name: "Piano.sf2"}
        expect(soundfont.file?.name).toBe("Piano.sf2")
        soundfont.presetIndex = 3
        expect(soundfont.presetIndex).toBe(3)
        const convolver = project.output.addAudioEffect("Convolver")
        expect(convolver.impulse).toBeNull()
        convolver.impulse = sample("Hall")
        expect(convolver.impulse?.name).toBe("Hall")
    })

    it("configures Cubed, Neon and MIDI output", () => {
        const {project} = createFixture()
        const cubed = project.addInstrumentUnit("Cubed").instrument
        expect(cubed.patterns.length).toBe(16)
        expect(cubed.patterns[0].steps.length).toBe(64)
        expect(cubed.patterns[0].length).toBe(16)
        const step = cubed.patterns[0].steps[0]
        expect(step.note).toBe(60)
        expect(step.active).toBe(false)
        step.note = 48
        step.active = true
        step.slide = true
        expect(step.note).toBe(48)
        expect(step.active).toBe(true)
        expect(step.slide).toBe(true)
        expect(step.accent).toBe(false)
        cubed.patterns[1].setSteps([{note: 36, active: true}, {note: 48, accent: true}])
        expect(cubed.patterns[1].length).toBe(2)
        expect(cubed.patterns[1].steps[1].accent).toBe(true)
        expect(cubed.patterns[1].steps[1].note).toBe(48)
        expect(() => cubed.patterns[1].setSteps([{note: "x" as any}])).toThrow(TypeError)
        cubed.patternIndex = 40
        expect(cubed.patternIndex).toBe(15)
        const neon = project.addInstrumentUnit("Neon").instrument
        expect(neon.envelopes.length).toBe(6)
        expect(neon.lines.length).toBe(2)
        expect(neon.envelopes[1].rate1).toBe(99)
        neon.envelopes[0].rate1 = 150
        expect(neon.envelopes[0].rate1).toBe(99)
        neon.lines[1].wave1 = 7
        expect(neon.lines[1].wave1).toBe(7)
        expect(() => neon.lines[1].wave1 = 8).toThrow(RangeError)
        neon.vibrato.depth = 50
        expect(neon.vibrato.depth).toBe(50)
        const midi = project.addInstrumentUnit("MIDIOutput").instrument
        midi.channel = 9
        expect(midi.channel).toBe(9)
        const cc = midi.addParameter({label: "Cutoff", controller: 74, value: 0.5})
        expect(midi.parameters).toEqual([cc])
        expect(cc.controller).toBe(74)
        expect(cc.value).toBe(0.5)
        cc.remove()
        expect(midi.parameters.length).toBe(0)
        const tape = project.addInstrumentUnit("Tape").instrument
        expect(tape.flutter).toBeCloseTo(0.2)
        tape.saturation = 1.5
        expect(tape.saturation).toBe(1)
    })
})
