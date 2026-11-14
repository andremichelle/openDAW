import {describe, expect, it} from "vitest"
import {Mixing} from "@opendaw/lib-dsp"
import {createFixture, sample} from "./Fixture"
import {AudioEffects, MIDIEffects} from "../Api"

describe("Devices", () => {
    it("adds every midi effect with defaults", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Vaporisateur")
        const keys: ReadonlyArray<keyof MIDIEffects> = ["Arpeggio", "Pitch", "NoteFilter", "ScaleMatrix", "ChordKeys", "Velocity", "Zeitgeist", "Spielwerk"]
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

    it("edits the Scale Matrix grid", () => {
        const {project} = createFixture()
        const matrix = project.addInstrumentUnit("Vaporisateur").addMIDIEffect("ScaleMatrix")
        expect([matrix.root, matrix.scale, matrix.follow]).toEqual([0, 0, false])
        expect(matrix.custom).toEqual(new Array(12).fill(0))
        matrix.scale = 15
        matrix.follow = true
        matrix.setCustom([0, -1, 0, 1, 0, 0, 12])
        expect(matrix.custom.slice(0, 7)).toEqual([0, -1, 0, 1, 0, 0, 12])
        matrix.setCustom([20])
        expect(matrix.custom[0]).toBe(12)
        expect(() => matrix.setCustom(new Array(13).fill(0))).toThrow(RangeError)
        matrix.root = 14
        expect(matrix.root).toBe(11)
    })

    it("edits Chord Keys", () => {
        const {project} = createFixture()
        const chordKeys = project.addInstrumentUnit("Vaporisateur").addMIDIEffect("ChordKeys")
        expect([chordKeys.root, chordKeys.scale, chordKeys.follow, chordKeys.voiceLeading]).toEqual([0, 0, true, false])
        chordKeys.scale = 3
        chordKeys.follow = false
        chordKeys.voiceLeading = true
        expect([chordKeys.scale, chordKeys.follow, chordKeys.voiceLeading]).toEqual([3, false, true])
        chordKeys.root = 14
        expect(chordKeys.root).toBe(11)
    })

    it("adds every audio effect with defaults", () => {
        const {project} = createFixture()
        const unit = project.addAuxUnit()
        const keys: ReadonlyArray<keyof AudioEffects> = [
            "Autotune", "Compressor", "Convolver", "Crusher", "DattorroReverb", "Delay", "Fold", "Gate", "Maximizer",
            "NeuralAmp", "Revamp", "Reverb", "StereoTool", "Tidal", "Vocoder", "Waveshaper", "Werkstatt",
            "Composite", "StereoSplit", "FrequencySplit", "Sink"
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
        const sink = unit.addAudioEffect("Sink")
        expect(sink.pass).toBe(Number.NEGATIVE_INFINITY)
        expect(sink.target).toBeNull()
        const group = project.addGroupUnit()
        sink.target = group
        expect(sink.target?.uuid).toBe(group.uuid)
        sink.pass = -6
        expect(sink.pass).toBe(-6)
        expect(() => sink.target = unit as any).toThrow(TypeError)
        sink.target = null
        expect(sink.target).toBeNull()
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
        arp.mode = 17
        expect(arp.mode).toBe(17)
        expect(() => arp.mode = 18).toThrow(RangeError)
        arp.octaves = 0
        expect(arp.octaves).toBe(1)
        const arpFull = unit.addMIDIEffect("Arpeggio", {order: 1, hold: true, retrigger: 2, offset: 3, seed: 4711, patternLength: 8})
        expect([arpFull.order, arpFull.hold, arpFull.retrigger, arpFull.offset, arpFull.seed, arpFull.patternLength])
            .toEqual([1, true, 2, 3, 4711, 8])
        expect(arpFull.steps.length).toBe(64)
        expect(arpFull.steps[0]).toEqual({kind: 0, velocity: 100, gate: 100, transpose: 0, octave: 0, chance: 100, ratchet: 1})
        arpFull.steps[5].kind = 2
        arpFull.steps[5].ratchet = 7
        arpFull.steps[5].transpose = -12
        expect(arpFull.steps[5].kind).toBe(2)
        expect(arpFull.steps[5].ratchet).toBe(7)
        expect(arpFull.steps[5].transpose).toBe(-12)
        expect(() => arpFull.steps[5].kind = 4).toThrow(RangeError)
        arpFull.steps[5].ratchet = 8
        expect(arpFull.steps[5].ratchet).toBe(7)
        arpFull.patternLength = 65
        expect(arpFull.patternLength).toBe(64)
        arpFull.offset = 16
        expect(arpFull.offset).toBe(15)
        expect(() => arpFull.retrigger = 4).toThrow(RangeError)
        const arpSteps = unit.addMIDIEffect("Arpeggio", {steps: [{kind: 3}, {velocity: 40, gate: 150}]})
        expect(arpSteps.steps[0].kind).toBe(3)
        expect(arpSteps.steps[1].velocity).toBe(40)
        expect(arpSteps.steps[1].gate).toBe(150)
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
        const waveshaper = unit.addAudioEffect("Waveshaper", {equation: "tanh"})
        expect(waveshaper.equation).toBe("tanh")
        expect(() => waveshaper.equation = 3 as any).toThrow(TypeError)
        expect(() => waveshaper.equation = "softclip" as any).toThrow(RangeError)
        expect(() => unit.addAudioEffect("Waveshaper", {equation: "tanh(x)" as any})).toThrow(RangeError)
        expect(waveshaper.equation).toBe("tanh")
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
        const wet = composite.addEntry({gain: -3, pan: 0.5})
        const dry = composite.addEntry()
        expect(composite.entries).toEqual([wet, dry])
        expect(wet.gain).toBe(-3)
        expect(wet.pan).toBe(0.5)
        expect(dry.index).toBe(1)
        expect(wet.composite).toBe(composite)
        const reverb = wet.addAudioEffect("Reverb")
        expect(wet.audioEffects).toEqual([reverb])
        expect(reverb.audioUnit).toBe(unit)
        wet.remove()
        expect(composite.entries).toEqual([dry])
        expect(dry.index).toBe(0)
        const stereo = unit.addAudioEffect("StereoSplit")
        expect(stereo.entries.map(entry => entry.index)).toEqual([0, 1])
        expect(() => stereo.entries[0].remove()).toThrow()
        const split = unit.addAudioEffect("FrequencySplit", {crossover1: 100})
        expect(split.entries.map(entry => entry.index)).toEqual([0, 1, 2, 3])
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

    it("builds a multi-sample Sampler", () => {
        const {project, host} = createFixture()
        const sampler = project.addInstrumentUnit("Sampler", {label: "Keys"}, {
            voices: 24, filter: {type: 1, cutoff: 4000}, ampEnvelope: {release: 2}, lfos: [{rate: 3}, {sync: true}]
        }).instrument
        expect(sampler.key).toBe("Sampler")
        expect(sampler.voices).toBe(24)
        expect(sampler.filter.type).toBe(1)
        expect(sampler.filter.cutoff).toBe(4000)
        expect(sampler.ampEnvelope.release).toBe(2)
        expect(sampler.modEnvelope.sustain).toBe(0)
        expect(sampler.lfos.length).toBe(2)
        expect(sampler.lfos[0].rate).toBe(3)
        expect(sampler.lfos[1].sync).toBe(true)
        sampler.voices = 500
        expect(sampler.voices).toBe(64)
        expect(() => {sampler.filter.type = 9 as 0}).toThrow(RangeError)
        // a new Sampler has one group and velocity to gain
        expect(sampler.groups.map(group => group.label)).toEqual(["Group 1"])
        expect(sampler.modulations.map(({source, target, amount}) => [source, target, amount])).toEqual([[4, 3, 1]])
        expect(sampler.zones).toEqual([])
        const low = sampler.addZone(sample("Low"), {keyLow: 0, keyHigh: 59, rootKey: 48, loopMode: 2, loopEnd: 1000})
        const high = sampler.addZone(sample("High"), {keyLow: 60, rootKey: 72})
        expect(sampler.zones).toEqual([low, high])
        expect([low.keyLow, low.keyHigh, low.rootKey, low.loopMode, low.loopStart, low.loopEnd]).toEqual([0, 59, 48, 2, 0, 1000])
        expect([high.keyLow, high.keyHigh, high.rootKey, high.sampleEnd]).toEqual([60, 127, 72, 0x7FFFFFFF])
        expect(low.sample.name).toBe("Low")
        expect(low.group).toBe(sampler.groups[0])
        expect(sampler.groups[0].zones).toEqual([low, high])
        low.keyHigh = 300
        expect(low.keyHigh).toBe(127)
        expect(() => sampler.addZone(sample("Bad"), {nope: 1} as object)).toThrow(TypeError)
        expect(sampler.zones.length).toBe(2) // a failed add leaves nothing behind
        // groups
        const releases = sampler.addGroup({label: "Release", trigger: 1, roundRobin: 2, choke: 3})
        expect(sampler.groups).toEqual([sampler.groups[0], releases])
        expect([releases.label, releases.trigger, releases.roundRobin, releases.choke]).toEqual(["Release", 1, 2, 3])
        expect(sampler.addGroup().label).toBe("Group 3")
        high.group = releases
        expect(high.group).toBe(releases)
        expect(releases.zones).toEqual([high])
        const click = sampler.addZone(sample("Click"), {group: releases, oneShot: true})
        expect(releases.zones).toEqual([high, click])
        const other = project.addInstrumentUnit("Sampler").instrument
        expect(() => {low.group = other.groups[0]}).toThrow("another Sampler")
        expect(() => {low.group = {} as typeof releases}).toThrow(TypeError)
        // swapping the sample drops the one nothing plays any more
        low.sample = sample("Lower")
        expect(low.sample.name).toBe("Lower")
        // modulations
        const vibrato = sampler.addModulation(2, 0, 0.02)
        const start = sampler.addModulation(6, 5, 4)
        expect(sampler.modulations.length).toBe(3)
        expect(sampler.modulations.at(-1)).toBe(start)
        expect(start.amount).toBe(1)
        expect(vibrato.amount).toBeCloseTo(0.02)
        expect(() => sampler.addModulation(7 as 0, 0, 0)).toThrow(RangeError)
        expect(sampler.modulations.length).toBe(3)
        vibrato.remove()
        expect(sampler.modulations).toEqual([sampler.modulations[0], start])
        // removing a group takes its zones along, the last group stays
        releases.remove()
        expect(high.attached).toBe(false)
        expect(click.attached).toBe(false)
        expect(sampler.zones).toEqual([low])
        low.remove()
        expect(sampler.zones).toEqual([])
        sampler.groups[1].remove()
        expect(() => sampler.groups[0].remove()).toThrow("last group")
        expect(sampler.groups.length).toBe(1)
        // the project opens and reads back
        const again = sampler.addZone(sample("Again"), {keyLow: 10, keyHigh: 20})
        project.openInStudio()
        expect(host.opened.length).toBe(1)
        expect(again.keyHigh).toBe(20)
    })

    it("reads a Sampler back from an open project", async () => {
        const {api, project} = createFixture()
        const built = project.addInstrumentUnit("Sampler", {label: "Keys"}).instrument
        built.addZone(sample("One"), {keyLow: 12, keyHigh: 14, rootKey: 13, loopMode: 1})
        built.addModulation(6, 5, 1)
        project.openInStudio()
        const loaded = await api.getProject()
        const sampler = loaded.audioUnits.map(unit => unit.kind === "instrument" ? unit.instrument : null)
            .find(instrument => instrument?.key === "Sampler")
        if (sampler?.key !== "Sampler") {throw new Error("no sampler")}
        expect(sampler.zones.map(zone => [zone.sample.name, zone.keyLow, zone.keyHigh, zone.rootKey, zone.loopMode]))
            .toEqual([["One", 12, 14, 13, 1]])
        expect(sampler.modulations.map(({source, target, amount}) => [source, target, amount])).toEqual([[4, 3, 1], [6, 5, 1]])
        sampler.zones[0].keyHigh = 20
        loaded.openInStudio()
        const reloaded = await api.getProject()
        expect(reloaded.audioUnits.length).toBe(loaded.audioUnits.length)
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

    it("builds Euclid lanes with their rhythm in every pattern", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("Playfield")
        const euclid = unit.addMIDIEffect("Euclid")
        expect(euclid.key).toBe("Euclid")
        expect(euclid.lanes.length).toBe(0)
        const kick = euclid.addLane({note: 36, velocity: 0.6, rhythms: [{steps: 16, pulses: 4}]})
        const snare = euclid.addLane({note: 38, gate: 1, rhythms: [{pulses: 2, rotate: 4}, {pulses: 3}]})
        expect(euclid.lanes.map(lane => lane.note)).toEqual([36, 38])
        expect(kick.velocity).toBeCloseTo(0.6)
        expect(kick.rhythms[0].pulses).toBe(4)
        expect(kick.rhythms[1].pulses).toBe(4)
        expect(snare.gate).toBe(1)
        expect(snare.rhythms[0].rotate).toBe(4)
        expect(snare.rhythms[1].pulses).toBe(3)
        expect(snare.rhythms.length).toBe(8)
        snare.rhythms[2].fade = -0.5
        expect(snare.rhythms[2].fade).toBeCloseTo(-0.5)
        euclid.pattern = 2
        euclid.rate = 3
        euclid.length = 32
        expect([euclid.pattern, euclid.rate, euclid.length]).toEqual([2, 3, 32])
        kick.remove()
        expect(euclid.lanes.map(lane => lane.note)).toEqual([38])
        expect(() => euclid.addLane({note: 200})).not.toThrow()
        expect(euclid.lanes[1].note).toBe(127)
    })

    it("puts instruments on Playfield pads next to sample slots", () => {
        const {project} = createFixture()
        const playfield = project.addInstrumentUnit("Playfield").instrument
        const slot = playfield.addSample(sample("Kick"), {note: 36})
        const kick = playfield.addPad("OpenDrumKick", {decay: 0.7, label: "Kick"}, {note: 37, gain: -3})
        const hat = playfield.addPad("OpenDrumHat", {decay: 0.13}, {exclude: true, key: 62})
        expect(kick.note).toBe(37)
        expect(kick.gain).toBe(-3)
        expect(kick.instrument.key).toBe("OpenDrumKick")
        expect(kick.instrument.decay).toBeCloseTo(0.7)
        expect(kick.instrument.label).toBe("Kick")
        expect(kick.playfield).toBe(playfield)
        expect(hat.note).toBe(60)
        expect(hat.key).toBe(62)
        expect(hat.exclude).toBe(true)
        expect(playfield.pads.map(pad => pad.note)).toEqual([37, 60])
        expect(playfield.slots.map(entry => entry.note)).toEqual([36])
        const effect = kick.addAudioEffect("Delay")
        expect(kick.audioEffects[0]).toBe(effect)
        const replaced = playfield.addPad("OpenDrumSnare", undefined, {note: 36})
        expect(() => slot.note).toThrow()
        expect(playfield.slots.length).toBe(0)
        expect(playfield.pads.map(pad => pad.instrument.key)).toEqual(["OpenDrumSnare", "OpenDrumKick", "OpenDrumHat"])
        replaced.remove()
        expect(playfield.pads.map(pad => pad.note)).toEqual([37, 60])
        expect(() => playfield.addPad("Nano" as "OpenDrumKick")).toThrow()
        expect(() => playfield.addPad("Playfield" as "OpenDrumKick")).toThrow()
        expect(playfield.addPad("OpenDrumKick", undefined, {note: 200}).note).toBe(127)
        expect(playfield.pads.length).toBe(3)
    })

    it("builds an Instrument Composite with layers, their chains and a nested composite", () => {
        const {project} = createFixture()
        const unit = project.addInstrumentUnit("InstrumentComposite", {label: "Stack"})
        const composite = unit.instrument
        expect(composite.key).toBe("InstrumentComposite")
        expect(composite.layers).toEqual([])
        const pad = composite.addLayer("Vaporisateur", {label: "Pad"})
        const bass = composite.addLayer("Nano", undefined, {gain: -6, pan: -0.5, mute: true})
        expect(composite.layers).toEqual([pad, bass])
        expect([pad.index, bass.index]).toEqual([0, 1])
        expect(pad.composite).toBe(composite)
        expect(pad.instrument.key).toBe("Vaporisateur")
        expect(pad.instrument.label).toBe("Pad")
        expect([bass.gain, bass.pan, bass.mute, bass.solo]).toEqual([-6, -0.5, true, false])
        expect(pad.instrument.audioUnit, "a layer's instrument still belongs to the unit").toBe(unit)
        const arp = pad.addMIDIEffect("Arpeggio")
        const delay = pad.addAudioEffect("Delay")
        expect(pad.midiEffects).toEqual([arp])
        expect(pad.audioEffects).toEqual([delay])
        expect(delay.audioUnit).toBe(unit)
        expect(unit.audioEffects, "a layer's effect is not the unit's").toEqual([])
        const neon = pad.setInstrument("Neon")
        expect(pad.instrument).toBe(neon)
        expect(pad.audioEffects, "the layer keeps its effects when its instrument changes").toEqual([delay])
        const inner = composite.addLayer("InstrumentComposite")
        const deep = inner.instrument.addLayer("Nano")
        expect(deep.composite).toBe(inner.instrument)
        expect(deep.instrument.audioUnit).toBe(unit)
        expect(() => composite.addLayer("Tape" as "Nano")).toThrow()
        expect(composite.layers.length).toBe(3)
        bass.remove()
        expect(composite.layers).toEqual([pad, inner])
        expect([pad.index, inner.index], "the order stays gapless").toEqual([0, 1])
        neon.remove()
        expect(composite.layers, "removing a layer's instrument removes the layer, never the unit").toEqual([inner])
        expect(project.audioUnits).toContain(unit)
    })

    it("configures Cubed, Neon and MIDI output", () => {
        const {project} = createFixture()
        const cubed = project.addInstrumentUnit("Cubed").instrument
        expect(cubed.patterns.length).toBe(16)
        expect(cubed.patterns[0].steps.length).toBe(64)
        expect(cubed.patterns[0].length).toBe(16)
        const step = cubed.patterns[0].steps[0]
        expect(step.note).toBe(36)
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
