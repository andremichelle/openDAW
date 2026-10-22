// Deterministic Matrix Synth -> Deminix
// by Chaosmeister - https://github.com/Chaosmeister
// Version 3: 
// - custom view goodness and massive extension
// >> new hexadecimal matrix upgrades the amount of possible values 
// >> from    387420489 
// >> to    68719476736
// >> possible combinations
// - each of the matrix values now change a specific property of the sound
// - extended tone / shaping section for even more control
// - real shuffle buttons, finally! unlimited creativity
// @label Deminix
// @view MatrixView 1 1 4 3
// @view ToneView 5 1 10 3
// @view PatchView 15 1 4 3
// @stream uiHints 256 value
// @collection matrix 9
// @field matrix.value 5 0 15 int
// @field matrix.lock false
// @collection snapshots 2
// @field snapshots.valid false
// @field snapshots.hex false
// @field snapshots.m0 5 0 15 int
// @field snapshots.m1 5 0 15 int
// @field snapshots.m2 5 0 15 int
// @field snapshots.m3 5 0 15 int
// @field snapshots.m4 5 0 15 int
// @field snapshots.m5 5 0 15 int
// @field snapshots.m6 5 0 15 int
// @field snapshots.m7 5 0 15 int
// @field snapshots.m8 5 0 15 int
// @field snapshots.filterEnv 0.45 0 1 linear
// @field snapshots.filterDecay 0.399128 0.02 4 exp s
// @field snapshots.width 0.5 0 1 linear
// @field snapshots.saturation 0.2 0 1 linear
// @field snapshots.partialDecay 0 0 1 linear
// @field snapshots.partialTime 0.501252 0.02 4 exp s
// @field snapshots.fmEnv 0 0 1 linear
// @field snapshots.fmTime 0.250392 0.02 4 exp s
// @field snapshots.velocityTimbre 0 0 1 linear
// @field snapshots.detune 1 0 1 linear
// @field snapshots.tremolo 1 0 1 linear
// @field snapshots.vibrato 1 0 1 linear
// @collection tone 1
// @field tone.filterEnv 0.45 0 1 linear
// @field tone.filterDecay 0.399128 0.02 4 exp s
// @field tone.width 0.5 0 1 linear
// @field tone.saturation 0.2 0 1 linear
// @field tone.partialDecay 0 0 1 linear
// @field tone.partialTime 0.501252 0.02 4 exp s
// @field tone.fmEnv 0 0 1 linear
// @field tone.fmTime 0.250392 0.02 4 exp s
// @field tone.velocityTimbre 0 0 1 linear
// @field tone.detune 1 0 1 linear
// @field tone.tremolo 1 0 1 linear
// @field tone.vibrato 1 0 1 linear

// ─── Deterministic PRNG (Mulberry32) ──────────────────────────────────────
class RNG {
    constructor(seed) {
        this.s = seed >>> 0
    }
    next() {
        this.s = (this.s + 0x6D2B79F5) >>> 0
        let t = this.s
        t = Math.imul(t ^ (t >>> 15), 1 | t)
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// ─── Waveshape functions ───────────────────────────────────────────────────
function waveTri(ph) { const p = ph % 1; return p < 0.5 ? 4 * p - 1 : 3 - 4 * p }

const FAMILY_NAMES = ['Reed / harmonium', 'Organ', 'Flute / breath', 'Pluck', 'Sub bass', 'Bell', 'Pad / strings', 'Choir / vowels', 'Noise / percussion', 'Metal / cymbal', 'Glass / crystal', 'Electric piano', 'Sync-style lead', 'Chiptune', 'Drone / fifths', 'Kick / tom']
const FAMILY_TYPES = [9, 0, 5, 1, 6, 2, 3, 7, 4, 8, 10, 11, 12, 13, 14, 15]

const VOICE_SCALARS = ["stage","decayRate","noiseState","noiseMix","sideFilter","filterEnvelope","baseCutoff","filter","filterRate","filterTarget","filterClock","fastRelease","id","active","gate","freq","velocity","gain","attackRate","releaseRate","sustainGain","numPartials","fmPhase","fmFreqMul","fmDepth","tremPhase","tremRate","tremDepth","vibPhase","vibRate","vibDepth","pitch","cent","fmEnvelope","smoothPartialAmount","smoothFMAmount","pitchEnvelope","pitchDepth","pitchRate","velocityShade","smoothDetune","smoothTremolo","smoothVibrato"]
const VOICE_ARRAYS = ["phases", "freqMul", "amps", "detuneAmt", "pan", "waveType", "partialGain", "partialRate"]

// ─── Voice ─────────────────────────────────────────────────────────────────
class Voice {
    constructor(maxPartials) {
        this.fmEnvelope = 1
        this.smoothPartialAmount = 0
        this.smoothFMAmount = 0
        this.smoothDetune = this.smoothTremolo = this.smoothVibrato = 1
        this.partialGain = new Float64Array(maxPartials).fill(1)
        this.partialRate = new Float64Array(maxPartials).fill(1)
        this.pitchEnvelope = 1
        this.pitchDepth = 0
        this.pitchRate = 1
        this.velocityShade = 0
        this.pitch = 69
        this.cent = 0
        this.sampleL = 0
        this.sampleR = 0
        this.fadeRemaining = 0
        this.pendingReady = false
        this.stage = 0
        this.decayRate = 0
        this.noiseState = 1
        this.noiseMix = 0
        this.sideFilter = 0
        this.filterEnvelope = 1
        this.baseCutoff = 1000
        this.filter = 0
        this.filterTarget = 1
        this.filterClock = 0
        this.filterRate = 1
        this.fastRelease = false
        this.id = -1
        this.active = false
        this.gate = false
        this.freq = 440
        this.velocity = 1
        this.gain = 0
        this.attackRate = 0
        this.releaseRate = 0
        this.sustainGain = 0.6
        this.numPartials = 1
        this.phases = new Float32Array(maxPartials)
        this.freqMul = new Float32Array(maxPartials)
        this.amps = new Float32Array(maxPartials)
        this.detuneAmt = new Float32Array(maxPartials)
        this.pan = new Float32Array(maxPartials)
        this.waveType = new Uint8Array(maxPartials)
        this.fmPhase = 0
        this.fmFreqMul = 1
        this.fmDepth = 0
        this.tremPhase = 0
        this.tremRate = 0
        this.tremDepth = 0
        this.vibPhase = 0
        this.vibRate = 0
        this.vibDepth = 0
    }
}

// ─── Processor ────────────────────────────────────────────────────────────
class Processor {
    static MAX_VOICES = 16
    static MAX_PARTIALS = 8

    voices = []
    params = new Int32Array(9).fill(5)
    filterEnv = 0.45
    filterDecay = 0.399128
    width = 0.5
    saturation = 0.2
    partialDecay = 0
    partialTime = 0.501252
    fmEnv = 0
    fmTime = 0.250392
    detune = 1
    tremolo = 1
    vibrato = 1
    velocityTimbre = 0
    smoothWidth = 0.5
    smoothDrive = 1.8

    constructor() {
        this.hintChars = new Float32Array(256)
        this.hintRevision = 0
        this.hintDirty = false
        this.sineTable = new Float64Array(4097)
        for (let i = 0; i <= 4096; i++) this.sineTable[i] = Math.sin(i * 6.283185307 / 4096)
        this.invSR = 1 / sampleRate
        this.smoothRate = 1 - Math.exp(-1 / (0.01 * sampleRate))
        this.filterDecayRate = Math.exp(-5 / (this.filterDecay * sampleRate))
        this.fmDecayRate = Math.exp(-5 / (this.fmTime * sampleRate))
        this.fadeLength = Math.max(1, Math.round(sampleRate * 0.02))
        this.invFadeLength = 1 / this.fadeLength
        for (let i = 0; i < Processor.MAX_VOICES; i++) {
            const v = new Voice(Processor.MAX_PARTIALS)
            v.active = false
            v.previous = new Voice(Processor.MAX_PARTIALS)
            v.pending = new Voice(Processor.MAX_PARTIALS)
            this.voices.push(v)
        }
    }

    message(data) {
        if (!data || data.type !== 'uiHint' || typeof data.text !== 'string') return
        this.hintChars.fill(0)
        this.hintChars[0] = ++this.hintRevision
        const length = Math.min(253, data.text.length)
        this.hintChars[1] = length
        this.hintChars[2] = data.transient ? 1 : 0
        for (let i = 0; i < length; i++) this.hintChars[i + 3] = data.text.charCodeAt(i)
        this.hintDirty = true
    }

    dataChanged(name) {
        if (name === 'tone') {
            const tone = this.data.tone[0]
            if (tone) {
                const previousAmount = this.filterEnv
                const previousDecay = this.filterDecay
                this._setTone('filterEnv', tone.filterEnv)
                this._setTone('filterDecay', tone.filterDecay)
                this._setTone('width', tone.width)
                this._setTone('saturation', tone.saturation)
                this._setTone('partialDecay', tone.partialDecay)
                this._setTone('partialTime', tone.partialTime)
                this._setTone('fmEnv', tone.fmEnv)
                this._setTone('fmTime', tone.fmTime)
                this._setTone('velocityTimbre', tone.velocityTimbre === undefined ? 0 : tone.velocityTimbre)
                for (const name of ['detune', 'tremolo', 'vibrato']) this._setTone(name, tone[name] === undefined ? 1 : tone[name])
                if (previousAmount !== this.filterEnv || previousDecay !== this.filterDecay) {
                    for (let i = 0; i < this.voices.length; i++) {
                        const voice = this.voices[i]
                        if (!voice.active) continue
                        voice.filterEnvelope = 1
                        voice.filterClock = 0
                        if (voice.fadeRemaining > 0) {
                            voice.previous.filterEnvelope = 1
                            voice.previous.filterClock = 0
                        }
                        if (voice.pendingReady) {
                            voice.pending.filterEnvelope = 1
                            voice.pending.filterClock = 0
                        }
                    }
                }
            }
            return
        }
        if (name !== "matrix") return
        const records = this.data.matrix
        let changed = false
        for (let i = 0; i < 9; i++) {
            const value = records[i] ? records[i].value : 5
            const next = Number.isFinite(value) ? Math.max(0, Math.min(15, Math.round(value))) : 5
            if (next !== this.params[i]) changed = true
            this.params[i] = next
        }
        if (!changed) return
        for (let i = 0; i < this.voices.length; i++) {
            const voice = this.voices[i]
            if (!voice.active) continue
            this._bakeVoice(voice.pending, voice.pitch, voice.velocity, voice.cent)
            voice.pendingReady = true
            if (voice.fadeRemaining === 0) this._beginTransition(voice)
        }
    }

    _copyVoice(target, source) {
        for (let i = 0; i < VOICE_SCALARS.length; i++) {
            const key = VOICE_SCALARS[i]
            target[key] = source[key]
        }
        for (let i = 0; i < VOICE_ARRAYS.length; i++) {
            const key = VOICE_ARRAYS[i]
            target[key].set(source[key])
        }
    }

    _inheritTime(target, source) {
        target.id = source.id
        target.active = source.active
        target.gain = source.gain
        target.gate = source.gate
        target.stage = source.stage
        target.fastRelease = source.fastRelease
        target.filterEnvelope = source.filterEnvelope
        target.filter = source.filter
        target.sideFilter = source.sideFilter
        target.filterRate = source.filterRate
        target.filterTarget = source.filterTarget
        target.filterClock = source.filterClock
        target.phases.set(source.phases)
        target.fmPhase = source.fmPhase
        target.tremPhase = source.tremPhase
        target.vibPhase = source.vibPhase
        target.noiseState = source.noiseState
        target.velocityShade = source.velocityShade
        target.pitchEnvelope = source.pitchEnvelope
        target.fmEnvelope = source.fmEnvelope
        target.partialGain.set(source.partialGain)
        target.smoothPartialAmount = source.smoothPartialAmount
        target.smoothFMAmount = source.smoothFMAmount
        target.smoothDetune = source.smoothDetune
        target.smoothTremolo = source.smoothTremolo
        target.smoothVibrato = source.smoothVibrato
    }

    _beginTransition(voice) {
        this._inheritTime(voice.pending, voice)
        this._copyVoice(voice.previous, voice)
        this._copyVoice(voice, voice.pending)
        voice.fadeRemaining = this.fadeLength
        voice.pendingReady = false
    }

    _setTone(name, value) {
        if (!Number.isFinite(value)) return
        value = toneValue(name, toneStep(name, value))
        if (name === 'filterEnv') this.filterEnv = Math.max(0, Math.min(1, value))
        if (name === 'filterDecay') {
            this.filterDecay = Math.max(0.02, Math.min(4, value))
            this.filterDecayRate = Math.exp(-5 / (this.filterDecay * sampleRate))
        }
        if (name === 'width') this.width = Math.max(0, Math.min(1, value))
        if (name === 'saturation') this.saturation = Math.max(0, Math.min(1, value))
        if (name === 'partialDecay') this.partialDecay = Math.max(0, Math.min(1, value))
        if (name === 'fmEnv') this.fmEnv = Math.max(0, Math.min(1, value))
        if (name === 'detune' || name === 'tremolo' || name === 'vibrato') this[name] = Math.max(0, Math.min(1, value))
        if (name === 'velocityTimbre') this.velocityTimbre = Math.max(0, Math.min(1, value))
        if (name === 'fmTime') {
            this.fmTime = Math.max(.02, Math.min(4, value))
            this.fmDecayRate = Math.exp(-5 / (this.fmTime * sampleRate))
        }
        if (name === 'partialTime') {
            const next = Math.max(.02, Math.min(4, value))
            if (next !== this.partialTime) {
                this.partialTime = next
                for (let i = 0; i < this.voices.length; i++) {
                    const voice = this.voices[i]
                    if (!voice.active) continue
                    this._partialRates(voice)
                    if (voice.fadeRemaining > 0) this._partialRates(voice.previous)
                    if (voice.pendingReady) this._partialRates(voice.pending)
                }
            }
        }
    }

    _filterCutoff(voice) {
        // Sweep zero retains the static matrix brightness. Positive sweep opens
        // above it, then closes below it; leave the fundamental audible.
        const floor = Math.max(30, voice.freq * .5)
        const octaves = this.filterEnv * (6 * voice.filterEnvelope - 3) + voice.velocityShade * 3
        return Math.min(sampleRate * .4, Math.max(floor, voice.baseCutoff * Math.pow(2, octaves)))
    }

    _partialRates(voice) {
        let lowest = Infinity, highest = 0
        for (let k = 0; k < voice.numPartials; k++) {
            lowest = Math.min(lowest, voice.freqMul[k])
            highest = Math.max(highest, voice.freqMul[k])
        }
        const span = Math.max(.001, highest - lowest)
        for (let k = 0; k < voice.numPartials; k++) {
            const height = (voice.freqMul[k] - lowest) / span
            voice.partialRate[k] = Math.exp(-5 * height / (this.partialTime * sampleRate))
        }
    }

    _bakeVoice(voice, pitch, velocity, cent) {
        // Only Character changes the seeded variation. Other cells have stable roles.
        const p = this.params
        const rng = new RNG(p[8] * 73856093)
        const family = FAMILY_TYPES[p[0]]
        const harmonicity = p[1] / 15
        const brightness = p[2] / 15
        const motion = p[3] / 15
        const percussive = family === 1 || family === 2 || family === 4 || family === 8 || family === 10 || family === 11 || family === 15
        voice.pitch = pitch
        voice.cent = cent
        voice.freq = 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)
        voice.velocity = Math.max(0, Math.min(1, velocity))
        voice.velocityShade = this.velocityTimbre * (voice.velocity - 1)
        voice.gain = 0
        voice.gate = true
        voice.stage = 0
        voice.fastRelease = false
        voice.fmEnvelope = 1
        voice.partialGain.fill(1)
        voice.smoothPartialAmount = this.partialDecay
        voice.smoothFMAmount = this.fmEnv
        voice.smoothDetune = this.detune
        voice.smoothTremolo = this.tremolo
        voice.smoothVibrato = this.vibrato
        const slowAttack = family === 3 || family === 7 || family === 14
        const attackSec = (slowAttack ? 0.04 : family === 5 ? 0.008 : 0.001) * Math.pow(slowAttack ? 60 : 150, p[4] / 15)
        const decaySec = (family === 2 || family === 8 || family === 10 ? 0.3 : 0.025) * Math.pow(60, p[5] / 15)
        const releaseSec = (family === 3 || family === 2 || family === 7 || family === 8 || family === 10 || family === 14 ? 0.08 : 0.008) * Math.pow(150, p[7] / 15)
        voice.attackRate = 1 / (attackSec * sampleRate)
        voice.decayRate = 1 - Math.exp(-5 / (decaySec * sampleRate))
        voice.releaseRate = 1 - Math.exp(-7 / (releaseSec * sampleRate))
        voice.sustainGain = Math.pow(p[6] / 15, 2) * (percussive ? 0.18 : 1)
        voice.numPartials = family === 15 ? 1 : family === 13 ? 5 : family === 3 ? 6 : 8
        voice.pitchEnvelope = 1
        voice.pitchDepth = family === 15 ? 2 + p[8] / 15 * 6 : 0
        voice.pitchRate = Math.exp(-8 / ((.015 + p[8] / 15 * .12) * sampleRate))
        voice.noiseState = (p[8] * 2654435761) >>> 0
        voice.noiseMix = family === 4 ? 0.3 + brightness * 0.65 : family === 5 ? 0.015 + brightness * 0.04 : family === 8 ? 0.08 + brightness * 0.15 : family === 9 ? .015 : family === 15 ? brightness * .025 : 0
        voice.sideFilter = 0
        voice.filterEnvelope = 1
        voice.filter = 0
        const cutoff = Math.min(sampleRate * 0.4, (family === 6 ? 80 : 180) * Math.pow(family === 6 ? 24 : 90, brightness))
        voice.baseCutoff = cutoff
        voice.filterRate = 1 - Math.exp(-6.283185307 * this._filterCutoff(voice) / sampleRate)
        voice.filterTarget = voice.filterRate
        voice.filterClock = 0
        let total = 0
        for (let k = 0; k < voice.numPartials; k++) {
            const n = k + 1
            const variation = rng.next()
            let ratio = n
            if (family === 2 || family === 4 || family === 8) {
                ratio = n + (1 - harmonicity) * (k * k * (family === 8 ? 0.73 : 0.21) + variation * k)
                if (family === 8) ratio *= 2.3
            } else if (family === 3) {
                ratio = k < 3 ? 1 : 2
            } else if (family === 6) {
                ratio = k === 0 ? 0.5 : k === 1 ? 1 : (k - 1) * 2 + 1
            } else {
                ratio = n + (1 - harmonicity) * k * 0.17
            }
            if (family === 9 || family === 13) ratio = k * 2 + 1 + (1 - harmonicity) * k * .05
            if (family === 10) ratio = n + .37 * k * k * (1.1 - harmonicity)
            if (family === 11) ratio = k === 0 ? 1 : n + (1 - harmonicity) * k * .015
            if (family === 12) ratio = k < 4 ? 1 : 2 + harmonicity
            if (family === 14) ratio = k < 2 ? 1 : k < 4 ? 1.5 : k < 6 ? 2 : 3
            if (family === 15) ratio = 1
            voice.pan[k] = (k % 2 === 0 ? -1 : 1) * (0.3 + variation * 0.5)
            voice.freqMul[k] = ratio
            voice.amps[k] = Math.pow(n, -(2.8 - brightness * 2.4)) * (0.8 + variation * 0.2)
            if (family === 3) voice.amps[k] = k < 3 ? 1 : 0.2 + brightness * 0.4
            if (family === 5) voice.amps[k] *= k === 0 ? 2 : k === 1 ? 0.45 : 0.08
            if (family === 6) voice.amps[k] = k === 0 ? 1 : k === 1 ? 0.7 : brightness * 0.4 / n
            if (family === 7) {
                // Two broad vocal formants; Character chooses the vowel.
                const hz = voice.freq * ratio
                const f1 = 350 + p[8] / 15 * 520
                const f2 = 1100 + p[8] / 15 * 1040
                voice.amps[k] = 0.08 / n + Math.exp(-Math.pow((hz - f1) / 180, 2)) + 0.6 * Math.exp(-Math.pow((hz - f2) / 300, 2))
            }
            if (family === 8) voice.amps[k] = 0.4 + variation * 0.6
            if (family === 9) voice.amps[k] *= .7 + .6 * Math.exp(-Math.pow((n - 3) / 2, 2))
            if (family === 10) voice.amps[k] = (.3 + variation * .7) / Math.pow(n, 1.2 - brightness)
            if (family === 11) voice.amps[k] *= k === 0 ? 2 : k === 1 ? .7 : .2
            if (family === 12) voice.amps[k] = k < 4 ? 1 : .25 + brightness * .5
            if (family === 13) voice.amps[k] = 1 / Math.pow(n * 2 - 1, 1.8 - brightness)
            if (family === 14) voice.amps[k] = k < 2 ? 1 : .45
            total += voice.amps[k]
            voice.phases[k] = family === 1 || family === 4 || family === 6 || family === 8 || family === 11 || family === 13 || family === 15 ? 0 : rng.next()
            voice.detuneAmt[k] = family === 7 ? (variation - 0.5) * motion * 0.008 : family === 3 ? (k % 3 - 1) * (0.002 + motion * 0.012) : 0
            if (family === 12 || family === 14) voice.detuneAmt[k] = (k % 2 ? 1 : -1) * (.001 + motion * .008)
            voice.waveType[k] = family === 3 || family === 12 ? 2 : family === 1 && k === 0 ? 1 : 0
        }
        for (let k = 0; k < voice.numPartials; k++) voice.amps[k] /= total
        voice.fmFreqMul = 1 + p[8] / 15 * 4
        voice.fmDepth = family === 8 ? 0.7 + brightness * 2.5 : family === 2 ? 0.2 + brightness * 1.8 : family === 4 ? brightness * 0.8 : family === 1 ? brightness * 0.12 : 0
        if (family === 9) voice.fmDepth = brightness * .05
        if (family === 10) voice.fmDepth = .08 + brightness * .6
        if (family === 11) voice.fmDepth = .1 + brightness * .5
        voice.fmPhase = 0
        voice.tremRate = 0.2 + motion * 7
        voice.tremDepth = motion * (family === 3 ? 0.25 : 0.12)
        voice.tremPhase = 0
        voice.vibRate = 3 + motion * 3
        voice.vibDepth = motion * (family === 3 ? 0.004 : 0.0015)
        voice.vibPhase = 0
        this._partialRates(voice)
    }

    noteOn(pitch, velocity, cent, id) {
        let voice = null
        for (const v of this.voices) {
            if (!v.active) { voice = v; break }
        }
        if (!voice) {
            let minGain = Infinity
            for (const v of this.voices) {
                if (v.gain < minGain) { minGain = v.gain; voice = v }
            }
        }
        voice.fadeRemaining = 0
        voice.pendingReady = false
        voice.id = id
        voice.active = true
        this._bakeVoice(voice, pitch, velocity, cent)
    }

    noteOff(id) {
        for (const v of this.voices) {
            if (v.active && v.id === id) {
                v.gate = false
                v.previous.gate = false
                v.pending.gate = false
                break
            }
        }
    }

    reset() {
        for (const v of this.voices) {
            if (v.active) {
                v.gate = false
                v.fastRelease = true
                v.previous.gate = false
                v.previous.fastRelease = true
                v.pending.gate = false
                v.pending.fastRelease = true
            }
        }
    }

    _sine(phase) {
        phase -= Math.floor(phase)
        const position = phase * 4096
        const index = position | 0
        const a = this.sineTable[index]
        return a + (this.sineTable[index + 1] - a) * (position - index)
    }

    _renderSample(v, invSR, filterDecayRate, smoothRate) {
        if (v.gate) {
            if (v.stage === 0) {
                v.gain = Math.min(1, v.gain + v.attackRate)
                if (v.gain >= 1) v.stage = 1
            } else {
                v.gain += (v.sustainGain - v.gain) * v.decayRate
            }
        } else {
            const rate = v.fastRelease ? 0.05 : v.releaseRate
            v.gain -= v.gain * rate
            if (v.gain < 0.00005) { v.active = false; v.sampleL = 0; v.sampleR = 0; return }
        }

        if (v.stage === 1 && v.sustainGain === 0 && v.gain < 0.000001) {
            v.sampleL = 0; v.sampleR = 0
            v.filter = 0; v.sideFilter = 0
            v.filterEnvelope *= filterDecayRate
            v.fmEnvelope *= this.fmDecayRate
            for (let k = 0; k < v.numPartials; k++) v.partialGain[k] *= v.partialRate[k]
            return
        }
        v.velocityShade += (this.velocityTimbre * (v.velocity - 1) - v.velocityShade) * smoothRate
        const velocityColor = 1 + v.velocityShade * .8
        const baseFreq = v.freq * (1 + v.pitchDepth * v.pitchEnvelope)
        v.pitchEnvelope *= v.pitchRate
        v.smoothDetune += (this.detune - v.smoothDetune) * smoothRate
        v.smoothTremolo += (this.tremolo - v.smoothTremolo) * smoothRate
        v.smoothVibrato += (this.vibrato - v.smoothVibrato) * smoothRate
        const vibMod = 1 + (v.vibDepth === 0 ? 0 : this._sine(v.vibPhase) * v.vibDepth * v.smoothVibrato)
        v.vibPhase += v.vibRate * invSR
        if (v.vibPhase >= 1) v.vibPhase -= 1

        v.smoothPartialAmount += (this.partialDecay - v.smoothPartialAmount) * smoothRate
        v.smoothFMAmount += (this.fmEnv - v.smoothFMAmount) * smoothRate
        const fmAccent = v.smoothFMAmount * v.fmEnvelope * velocityColor
        const fmDepth = v.fmDepth * velocityColor + fmAccent * 3
        const fmSig = fmDepth === 0 ? 0 : this._sine(v.fmPhase) * fmDepth
        v.fmEnvelope *= this.fmDecayRate
        v.fmPhase = (v.fmPhase + baseFreq * v.fmFreqMul * vibMod * invSR) % 1

        let sig = 0
        let side = 0
        const np = v.numPartials
        for (let k = 0; k < np; k++) {
            const pFreq = baseFreq * v.freqMul[k] * vibMod * (1 + v.detuneAmt[k] * v.smoothDetune)
            const phAdv = Math.min(0.45, pFreq * invSR)
            // Cull partials above Nyquist; pad saws use PolyBLEP edges.
            if (pFreq < sampleRate * 0.45) {
                const phase = v.phases[k]
                let value
                if (v.waveType[k] === 2) {
                    value = 2 * phase - 1
                    if (phase < phAdv) { const t = phase / phAdv; value -= t + t - t * t - 1 }
                    else if (phase > 1 - phAdv) { const t = (phase - 1) / phAdv; value -= t * t + t + t + 1 }
                } else {
                    value = v.waveType[k] === 0 ? this._sine(phase + fmSig / 6.283185307) : waveTri(phase)
                }
                // A fading sine-FM layer gives saw/triangle families an accent too.
                if (v.waveType[k] !== 0 && fmAccent > 0.00001) {
                    const mix = fmAccent * .4
                    value += (this._sine(phase + fmSig / 6.283185307) - value) * mix
                }
                const spectralGain = 1 - v.smoothPartialAmount * (1 - v.partialGain[k])
                const partial = value * v.amps[k] * spectralGain
                sig += partial
                // Fundamentals below 160 Hz stay centered; upper harmonics spread.
                side += partial * v.pan[k] * Math.max(0, Math.min(1, (pFreq - 160) / 500))
            }
            v.partialGain[k] *= v.partialRate[k]
            const nextPhase = v.phases[k] + phAdv
            v.phases[k] = nextPhase >= 1 ? nextPhase - 1 : nextPhase
        }

        const trem = 1 - v.tremDepth * v.smoothTremolo * (0.5 + 0.5 * this._sine(v.tremPhase))
        v.tremPhase += v.tremRate * invSR
        if (v.tremPhase >= 1) v.tremPhase -= 1

        v.noiseState = (Math.imul(v.noiseState, 1664525) + 1013904223) >>> 0
        sig = sig * (1 - v.noiseMix) + (v.noiseState / 2147483648 - 1) * v.noiseMix
        // Recompute expensive coefficients at a sample-counted control rate (~1.5 kHz).
        // Continue smoothing the coefficient and decaying the envelope every sample.
        if (v.filterClock === 0) {
            const cutoff = this._filterCutoff(v)
            v.filterTarget = 1 - Math.exp(-6.283185307 * cutoff * invSR)
            v.filterClock = 32
        }
        v.filterClock--
        v.filterRate += (v.filterTarget - v.filterRate) * smoothRate
        if (v.stage !== 0 || !v.gate) v.filterEnvelope *= filterDecayRate
        v.filter += (sig - v.filter) * v.filterRate
        v.sideFilter += (side * (1 - v.noiseMix) - v.sideFilter) * v.filterRate
        const gain = v.gain * v.velocity * trem
        v.sampleL = (v.filter + v.sideFilter) * gain
        v.sampleR = (v.filter - v.sideFilter) * gain
    }

    process(output, block) {
        const outL = output[0]
        const outR = output[1]
        const invSR = this.invSR
        const filterDecayRate = this.filterDecayRate
        const smoothRate = this.smoothRate

        for (let vi = 0; vi < this.voices.length; vi++) {
            const v = this.voices[vi]
            if (!v.active) continue

            for (let s = block.s0; s < block.s1; s++) {
                if (v.fadeRemaining === 0 && v.pendingReady) this._beginTransition(v)
                this._renderSample(v, invSR, filterDecayRate, smoothRate)
                if (v.fadeRemaining > 0) {
                    this._renderSample(v.previous, invSR, filterDecayRate, smoothRate)
                    const mix = 1 - v.fadeRemaining * this.invFadeLength
                    outL[s] += v.previous.sampleL * (1 - mix) + v.sampleL * mix
                    outR[s] += v.previous.sampleR * (1 - mix) + v.sampleR * mix
                    v.fadeRemaining--
                    if (!v.active && v.previous.active) v.active = true
                } else {
                    outL[s] += v.sampleL
                    outR[s] += v.sampleR
                }
                if (!v.active) { v.pendingReady = false; break }
            }
        }
        for (let s = block.s0; s < block.s1; s++) {
            this.smoothWidth += (this.width - this.smoothWidth) * smoothRate
            this.smoothDrive += (1 + this.saturation * 4 - this.smoothDrive) * smoothRate
            const mid = (outL[s] + outR[s]) * 0.5
            const side = (outL[s] - outR[s]) * 0.5 * this.smoothWidth
            let l = (mid + side) * this.smoothDrive
            let r = (mid - side) * this.smoothDrive
            // Unity slope below the knee; smooth, bounded saturation above it.
            l = Math.abs(l) <= 0.8 ? l : Math.sign(l) * (0.8 + 0.2 * Math.tanh((Math.abs(l) - 0.8) * 5))
            r = Math.abs(r) <= 0.8 ? r : Math.sign(r) * (0.8 + 0.2 * Math.tanh((Math.abs(r) - 0.8) * 5))
            outL[s] = l
            outR[s] = r
        }
        if (this.hintDirty && this.streams && this.streams.uiHints && this.streams.uiHints.active) {
            this.streams.uiHints.set(this.hintChars)
            this.hintDirty = false
        }
    }
}

const TONE_NAMES = ['filterEnv', 'filterDecay', 'width', 'saturation', 'partialDecay', 'partialTime', 'fmEnv', 'fmTime', 'velocityTimbre', 'detune', 'tremolo', 'vibrato']
const TONE_DEFAULTS = {velocityTimbre:0, detune:1, tremolo:1, vibrato:1}

function flashStatus(element, text) {
    clearTimeout(element._clearTimer)
    element.textContent = text
    element._clearTimer = setTimeout(() => { element.textContent = element._hintText || element._idleText || '' }, 2800)
}
function isToneTime(name) {
    return name === 'filterDecay' || name === 'partialTime' || name === 'fmTime'
}
function toneStep(name, value) {
    const normalized = isToneTime(name) ? Math.log(Math.max(.02, Math.min(4, value)) / .02) / Math.log(200) : value
    return Math.max(0, Math.min(1000, Math.round(normalized * 1000)))
}
function toneValue(name, step) {
    step = Math.max(0, Math.min(1000, Math.round(step)))
    // Microsecond precision preserves every logarithmic slider position on export.
    return isToneTime(name) ? Math.round(.02 * Math.pow(200, step / 1000) * 1000000) / 1000000 : step / 1000
}
function quantizedTone(tone) {
    const result = {}
    for (const name of TONE_NAMES) result[name] = toneValue(name, toneStep(name, tone[name] === undefined ? TONE_DEFAULTS[name] : tone[name]))
    return result
}
function readTone(host) {
    return quantizedTone(host.data.tone.get(0))
}
function validTone(tone) {
    if (!tone || typeof tone !== 'object' || Array.isArray(tone)) return false
    for (const name of TONE_NAMES) {
        const value = tone[name]
        if (value === undefined && TONE_DEFAULTS[name] !== undefined) continue
        if (!Number.isFinite(value) || value < (isToneTime(name) ? .02 : 0) || value > (isToneTime(name) ? 4 : 1)) return false
    }
    return true
}
function hexDigit(value) { return value.toString(16).toUpperCase() }
function publishHint(host, text, transient = false) {
    host.send({type:'uiHint', text, transient})
}
function bindHint(host, element, text) {
    const show = () => publishHint(host, typeof text === 'function' ? text() : text)
    element.addEventListener('pointerenter', show)
    element.addEventListener('pointerleave', () => { if (!element.contains(document.activeElement)) publishHint(host, '') })
    element.addEventListener('focusin', show)
    element.addEventListener('focusout', event => { if (!element.matches(':hover') && !element.contains(event.relatedTarget)) publishHint(host, '') })
}
function familyColor(name, opacity = 1) {
    return 'hsl(var(--family-hue) ' + (name === 'displayGrid' ? '62% 72%' : '78% 85%') + ' / ' + opacity + ')'
}
function terminateSubscription(subscription) {
    if (typeof subscription === 'function') subscription()
    else if (subscription && typeof subscription.terminate === 'function') subscription.terminate()
}
function installFamilyTheme(host) {
    host.root.style.setProperty('--family-surface', 'hsl(var(--family-hue) 22% 13%)')
    const update = () => host.root.style.setProperty('--family-hue',
        (host.data.matrix.get(0).value * 360 / 16).toFixed(3))
    const style = document.createElement('style')
    style.textContent = `
        * { box-sizing:border-box; }
        :where(.deminix, .tone, .patch) { margin:1px; width:calc(100% - 2px); height:calc(100% - 2px); padding:4px;
            border:.5px solid ${familyColor('displayGrid', .12)}; border-radius:8px; display:grid;
            gap:3px; font:inherit; font-size:11px; color:${familyColor('displayStroke')}; background:var(--family-surface); }
        :where(.deminix, .tone, .patch) button { font:inherit; color:inherit; background:transparent;
            border:1px solid var(--button-border, ${familyColor('displayGrid', .18)}); border-radius:4px; cursor:pointer; }
        .caption, .title, .patchTitle { font-size:9px; letter-spacing:.08em; }
        .actions, .toneActions, .patchRow { display:flex; gap:3px; }
        button:focus-visible { outline:1px solid ${familyColor('displayStroke', .75)}; outline-offset:-2px; }
        :root button { background:transparent; }
        :root button:hover:not(:disabled), :root button:focus-visible {
            background:${familyColor('displayStroke', .16)};
            border-color:${familyColor('displayStroke', .75)};
        }
        :root button:hover:disabled { background:${familyColor('displayStroke', .04)}; }
        ::selection { background:hsl(var(--family-hue) 78% 50% / .35); }
    `
    host.root.append(style)
    update()
    return host.data.matrix.subscribe(update)
}
function legacyMatrix(values) {
    if (!Array.isArray(values) || values.length !== 9 || !values.every(value => Number.isInteger(value) && value >= 1 && value <= 9)) return null
    return values.map((value, index) => index === 0 ? value : Math.round((value - 1) * 15 / 8))
}
function shuffleMatrix(host) {
    const currentFamily = host.data.matrix.get(0).value
    let f = currentFamily
    if (!host.data.matrix.get(0).lock) {
        f = Math.floor(Math.random() * 15)
        if (f >= currentFamily) f++
        host.data.matrix.set(0, {value:f})
    }
    // Ranges for harmonicity, brightness, motion, attack, decay, sustain, release, character.
    const ranges = [
        [[10,15],[3,12],[0,7],[1,8],[4,12],[9,15],[2,10],[0,15]],
        [[11,15],[2,11],[0,6],[0,8],[4,13],[9,15],[1,11],[0,15]],
        [[11,15],[2,9],[2,8],[2,8],[6,13],[9,15],[2,8],[0,15]],
        [[9,15],[4,15],[0,4],[0,2],[2,11],[0,4],[2,9],[0,15]],
        [[11,15],[0,9],[0,4],[0,4],[2,9],[4,13],[0,6],[0,15]],
        [[0,11],[4,15],[0,4],[0,2],[8,15],[0,2],[8,15],[0,15]],
        [[8,15],[2,13],[4,13],[4,13],[8,15],[8,15],[8,15],[0,15]],
        [[11,15],[4,13],[2,9],[4,11],[6,13],[9,15],[6,13],[0,15]],
        [[0,13],[2,15],[0,4],[0,0],[0,8],[0,0],[0,6],[0,15]],
        [[0,8],[8,15],[0,6],[0,2],[6,15],[0,2],[6,15],[0,15]],
        [[1,10],[7,15],[0,4],[0,2],[9,15],[0,2],[8,15],[0,15]],
        [[12,15],[3,12],[0,5],[0,3],[5,12],[0,6],[3,10],[0,15]],
        [[7,15],[7,15],[2,12],[0,5],[4,12],[7,15],[2,9],[0,15]],
        [[12,15],[4,15],[0,5],[0,1],[1,8],[0,12],[0,6],[0,15]],
        [[6,15],[2,12],[4,15],[6,15],[8,15],[10,15],[9,15],[0,15]],
        [[12,15],[0,10],[0,2],[0,0],[1,8],[0,0],[0,5],[0,15]]
    ][f]
    for (let i = 1; i < 9; i++) if (!host.data.matrix.get(i).lock) {
        const range = ranges[i - 1]
        host.data.matrix.set(i, {value:range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1))})
    }
    return f
}
function mutateMatrix(host) {
    const candidates = []
    for (let i = 1; i < 9; i++) if (!host.data.matrix.get(i).lock) candidates.push(i)
    if (candidates.length === 0) return 0
    const count = Math.min(candidates.length, 1 + Math.floor(Math.random() * 3))
    host.edit(() => {
        for (let n = 0; n < count; n++) {
            const pick = Math.floor(Math.random() * candidates.length)
            const index = candidates.splice(pick, 1)[0]
            const value = host.data.matrix.get(index).value
            const step = 1 + Math.floor(Math.random() * 2)
            let next = value + (Math.random() < .5 ? -step : step)
            if (next < 0 || next > 15) next = value + (next < 0 ? step : -step)
            host.data.matrix.set(index, {value:next})
        }
    })
    return count
}
function randomTone(family) {
    const time = () => .04 * Math.pow(50, Math.random())
    return quantizedTone({
        filterEnv:.15 + Math.random() * .85, filterDecay:time(),
        width:Math.random() * (family === 4 ? .25 : 1), saturation:Math.random() * .45,
        partialDecay:Math.random() * .85, partialTime:time(),
        fmEnv:Math.random() * (family === 2 || family === 6 || family === 7 ? .35 : .75), fmTime:time(), velocityTimbre:Math.random() * .8, detune:Math.random(), tremolo:Math.random(), vibrato:Math.random()
    })
}

// The view runs separately from the audio processor. Only host.data is shared.
class MatrixView {
    constructor(host) {
        this.host = host
        this.subscriptions = [installFamilyTheme(host)]
        this.drag = null
        this.selected = 0
        this.cells = []
        this.quickLocks = []
        this.roles = ['Family', 'Harmonics', 'Brightness', 'Motion', 'Attack', 'Decay', 'Sustain', 'Release', 'Character']
        this.descriptions = [
            'Choose a sound family',
            'Inharmonic → harmonic',
            'Dark → bright',
            'Detune, vibrato and tremolo',
            'Fade-in time',
            'Time to sustain level',
            'Held-note level',
            'Fade-out after note-off',
            'Overtone and FM variation'
        ]
        const root = host.root
        const style = document.createElement('style')
        style.textContent = `
            .deminix { --button-border:${familyColor('displayGrid', .12)}; grid-template-columns:minmax(0,1fr); grid-template-rows:12px minmax(0,1fr) 22px; gap:4px 6px; }
            .matrix { display:grid; grid-template:repeat(3,minmax(0,1fr))/repeat(3,minmax(0,1fr)); gap:3px; min-height:0; }
            .matrixCell { position:relative; min-width:0; min-height:0; }
            .quickLock { position:absolute; right:1px; bottom:1px; width:18px; height:19px; padding:2px; display:grid; place-items:center; border-color:transparent; opacity:.85; touch-action:manipulation; }
            .quickLock[aria-pressed=true], .quickLock:hover, .quickLock:focus-visible { opacity:1; }
            .quickLock svg { width:13px; height:13px; pointer-events:none; }
            .cell { width:100%; height:100%; position:relative; font-size:17px; line-height:1; touch-action:none; cursor:ns-resize; padding:6px 14px 0 0; }
            .cell[aria-selected=true] { border-color:${familyColor('displayStroke', .45)}; background:${familyColor('displayStroke', .06)}; }
            .index { position:absolute; top:1px; left:3px; max-width:calc(100% - 6px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:8px; opacity:1; }
            .level { position:absolute; bottom:3px; left:4px; height:2px; background:${familyColor('displayStroke', .45)}; pointer-events:none; }
            .matrixActions { grid-column:1/-1; min-width:0; }
            .matrixActions button { min-width:0; padding:3px 2px; white-space:nowrap; }
            .actions button { padding:3px 4px; flex:1; font-size:9px; }
            button[aria-pressed=true] { background:${familyColor('displayStroke', .1)}; border-color:${familyColor('displayStroke', .65)}; }
        `
        const panel = document.createElement('div')
        panel.className = 'deminix'
        const matrix = document.createElement('div')
        matrix.className = 'matrix'
        matrix.setAttribute('role', 'group')
        matrix.setAttribute('aria-label', 'Sound seed matrix, row by row')
        for (let i = 0; i < 9; i++) {
            const cell = document.createElement('button')
            cell.className = 'cell'
            cell.type = 'button'
            cell.innerHTML = `<span class="index">${this.roles[i]}</span><span class="digit"></span><span class="level"></span>`
            bindHint(host, cell, this.roles[i] + ': ' + this.descriptions[i])
            cell.addEventListener('pointerdown', event => this.start(event, i))
            cell.addEventListener('pointermove', event => this.move(event))
            cell.addEventListener('pointerup', () => this.finish())
            cell.addEventListener('pointercancel', () => this.finish())
            cell.addEventListener('lostpointercapture', () => this.finish())
            cell.addEventListener('focus', () => { this.selected = i; this.render() })
            cell.addEventListener('keydown', event => this.key(event, i))
            cell.addEventListener('dblclick', () => { this.finish(); host.edit(() => this.set(i, 5)) })
            const wrapper = document.createElement('div')
            wrapper.className = 'matrixCell'
            const lock = document.createElement('button')
            lock.type = 'button'
            lock.className = 'quickLock'
            lock.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path class="shackle"/><path d="M12 14v3"/></svg>'
            bindHint(host, lock, () => (this.locked(i) ? 'Unlock ' : 'Lock ') + this.roles[i])
            lock.addEventListener('click', () => {
                this.finish()
                const locked = !this.locked(i)
                host.edit(() => host.data.matrix.set(i, { lock: locked ? 1 : 0 }))
                this.setStatus(this.roles[i] + (locked ? ' locked for shuffle' : ' free for shuffle'))
            })
            wrapper.append(cell, lock)
            matrix.append(wrapper)
            this.quickLocks.push(lock)
            this.cells.push(cell)
        }
        const title = document.createElement('div')
        title.className = 'caption'
        title.textContent = 'MATRIX'
        const actions = document.createElement('div')
        actions.className = 'actions matrixActions'
        actions.innerHTML = '<button type="button">Shuffle</button><button type="button">Mutate</button><button type="button">Copy</button><button type="button">Paste</button>'
        const clipboardButtons = [actions.querySelectorAll('button')[2], actions.querySelectorAll('button')[3]]
        bindHint(host, clipboardButtons[0], 'Copy matrix')
        bindHint(host, clipboardButtons[1], 'Paste matrix')
        this.clipboard = new ViewClipboard(host, text => this.setStatus(text), 'seed', () => this.seedText(), text => this.applySeed(text))
        clipboardButtons[0].addEventListener('click', () => this.clipboard.copy())
        clipboardButtons[1].addEventListener('click', () => this.clipboard.paste())
        const buttons = actions.querySelectorAll('button')
        bindHint(host, buttons[0], 'Shuffle unlocked fields')
        buttons[0].addEventListener('click', () => this.shuffle())
        bindHint(host, buttons[1], 'Vary 1–3 unlocked fields')
        buttons[1].addEventListener('click', () => {
            this.finish()
            const count = mutateMatrix(host)
            this.setStatus(count ? count + ' fields mutated' : 'No unlocked shape fields to mutate')
        })
        panel.append(title, matrix, actions)
        root.append(style, panel)
        this.subscriptions.push(host.data.matrix.subscribe(() => this.render()))
        this.render()
    }
    setStatus(text) { publishHint(this.host, text, true) }
    locked(i) { return !!this.host.data.matrix.get(i).lock }
    value(i) { return this.host.data.matrix.get(i).value }
    set(i, value) {
        value = Math.max(0, Math.min(15, Math.round(value)))
        if (this.value(i) !== value) this.host.data.matrix.set(i, { value })
    }
    render() {
        for (let i = 0; i < 9; i++) {
            const value = this.value(i)
            const cell = this.cells[i]
            cell.querySelector('.digit').textContent = hexDigit(value)
            cell.querySelector('.index').textContent = i === 0 ? FAMILY_NAMES[value] : this.roles[i]
            const lock = this.quickLocks[i]
            const locked = this.locked(i)
            lock.setAttribute('aria-pressed', String(locked))
            lock.setAttribute('aria-label', (locked ? 'Unlock ' : 'Lock ') + this.roles[i])
            lock.querySelector('.shackle').setAttribute('d', locked ? 'M8 10V7a4 4 0 0 1 8 0v3' : 'M8 10V6a4 4 0 0 1 8 0')
            cell.querySelector('.level').style.width = `${value / 15 * 45}%`
            cell.setAttribute('aria-label', `${this.roles[i]}${i === 0 ? ': ' + FAMILY_NAMES[value] : ''}, value ${hexDigit(value)}. Type a hexadecimal digit or use up and down arrows.`)
            cell.setAttribute('aria-selected', String(i === this.selected))
        }
    }

    start(event, i) {
        if (event.button !== 0 || this.drag) return
        event.preventDefault()
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        this.drag = { i, y: event.clientY, value: this.value(i), gesture: this.host.gesture() }
        publishHint(this.host, this.roles[i] + ': ' + this.descriptions[i])
    }
    move(event) {
        if (!this.drag) return
        const drag = this.drag
        const value = drag.value + Math.round((drag.y - event.clientY) / (event.shiftKey ? 24 : 10))
        drag.gesture.edit(() => this.set(drag.i, value))
    }
    finish() {
        if (!this.drag) return
        const drag = this.drag
        this.drag = null
        drag.gesture.end()
    }
    key(event, i) {
        if (event.ctrlKey || event.metaKey || event.altKey) return
        let value
        if (/^[0-9a-f]$/i.test(event.key)) value = parseInt(event.key, 16)
        else if (event.key === 'ArrowUp' || event.key === 'ArrowRight') value = this.value(i) + 1
        else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') value = this.value(i) - 1
        else if (event.key === 'Home') value = 0
        else if (event.key === 'End') value = 15
        else return
        event.preventDefault()
        this.host.edit(() => this.set(i, value))
    }
    seedText() {
        let text = ''
        for (let i = 0; i < 9; i++) text += hexDigit(this.value(i))
        return text
    }
    applySeed(text) {
        const digits = String(text).replace(/\s/g, '').replace(/^0x/i, '')
        if (!/^[0-9a-f]{9}$/i.test(digits)) return false
        this.finish()
        this.host.edit(() => {
            for (let i = 0; i < 9; i++) this.set(i, parseInt(digits[i], 16))
        })
        return true
    }
    shuffle() {
        this.finish()
        let family
        this.host.edit(() => { family = shuffleMatrix(this.host) })
        this.setStatus(FAMILY_NAMES[family] + ' shuffled · locks preserved')
    }
    terminate() {
        this.finish()
        this.clipboard.terminate()
        for (const subscription of this.subscriptions) terminateSubscription(subscription)
    }
}

class ToneView {
    constructor(host) {
        this.host = host
        this.subscriptions = [installFamilyTheme(host)]
        this.controls = []
        const style = document.createElement('style')
        style.textContent = `
            .tone { grid-template-rows:12px minmax(0,1fr) 22px; }
            .title { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
            .toneActions button { flex:1; padding:3px; font-size:9px; }
            .toneControls { display:grid; grid-template:minmax(0,1fr)/repeat(3,minmax(0,2fr)) repeat(2,minmax(0,3fr)); gap:4px; min-height:0; }
            .tonePair { min-height:0; min-width:0; padding:2px 4px; border:1px solid ${familyColor('displayGrid', .15)}; border-radius:4px; display:grid; grid-template-rows:10px minmax(0,1fr); gap:1px; }
            .pairTitle { font-size:8px; letter-spacing:.06em; }
            .pairControls { display:grid; grid-template-columns:1fr 1fr; gap:7px; min-height:0; }
            .tone label { display:grid; grid-template-rows:10px minmax(0,1fr) 10px; justify-items:center; gap:2px; min-width:0; min-height:0; font-size:9px; }
            .value { font-size:9px; font-variant-numeric:tabular-nums; opacity:1; }
            .tone input[type=range] { writing-mode:vertical-lr; direction:rtl; width:16px; height:100%; min-height:0; margin:0; touch-action:none; accent-color:${familyColor('displayStroke', .85)}; }
            input:focus-visible { outline:1px solid ${familyColor('displayStroke', .75)}; outline-offset:2px; }
        `
        const panel = document.createElement('div')
        panel.className = 'tone'
        const title = document.createElement('div')
        title.className = 'title'
        title.textContent = 'TONE / SHAPING'
        const controls = document.createElement('div')
        controls.className = 'toneControls'
        const definitions = [
            ['filterEnv', 'FILTER', 'Filter sweep', 'Amount', 'Filter envelope depth'],
            ['filterDecay', 'FILTER', 'Filter decay', 'Decay', 'Filter envelope time'],
            ['partialDecay', 'PARTIAL DECAY', 'Partial fade', 'Amount', 'Upper-overtone fade amount'],
            ['partialTime', 'PARTIAL DECAY', 'Partial decay', 'Decay', 'Upper-overtone fade time'],
            ['fmEnv', 'FM', 'FM accent', 'Amount', 'Initial FM boost'],
            ['fmTime', 'FM', 'FM decay', 'Decay', 'FM boost fade time'],
            ['detune', 'MOTION', 'Detune', 'Detune', 'Detune multiplier'],
            ['tremolo', 'MOTION', 'Tremolo', 'Trem', 'Tremolo depth multiplier'],
            ['vibrato', 'MOTION', 'Vibrato', 'Vib', 'Vibrato depth multiplier'],
            ['width', 'OUTPUT / EXPRESSION', 'Stereo width', 'Width', 'Stereo spread; 0 = mono'],
            ['saturation', 'OUTPUT / EXPRESSION', 'Saturation', 'Drive', 'Soft-clipping drive'],
            ['velocityTimbre', 'OUTPUT / EXPRESSION', 'Velocity → Timbre', 'Vel', 'Velocity sensitivity of brightness and FM']
        ]
        const groups = new Map()
        for (const caption of new Set(definitions.map(([, group]) => group))) {
            const pair = document.createElement('div')
            pair.className = 'tonePair'
            pair.setAttribute('role', 'group')
            pair.setAttribute('aria-label', caption)
            const heading = document.createElement('div')
            heading.className = 'pairTitle'; heading.textContent = caption
            const body = document.createElement('div')
            body.className = 'pairControls'
            if (caption === 'MOTION' || caption === 'OUTPUT / EXPRESSION') body.style.gridTemplateColumns = 'repeat(3,minmax(0,1fr))'
            pair.append(heading, body); controls.append(pair); groups.set(caption, body)
        }
        for (const [name, group, caption, shortLabel, hint] of definitions) {
            const label = document.createElement('label')
            bindHint(host, label, caption + ': ' + hint)
            const text = document.createElement('span')
            text.textContent = shortLabel
            const value = document.createElement('span')
            value.className = 'value'
            const input = document.createElement('input')
            input.type = 'range'; input.min = 0; input.max = 1; input.step = .001
            input.setAttribute('aria-label', caption)
            input.setAttribute('aria-orientation', 'vertical')
            const control = {name, input, value, gesture:null, drag:null}
            let dragged = false
            label.addEventListener('pointerdown', () => { dragged = false })
            const end = event => {
                control.drag = null
                if (control.gesture) {
                    const gesture = control.gesture
                    control.gesture = null
                    gesture.end()
                }
                // Pointer editing must not leave arrow/space keys captured by the slider.
                // Keyboard focus from Tab stays available until the user moves it.
                if (event && event.type !== 'blur' && dragged) input.blur()
            }
            const writePosition = position => {
                const step = Math.round(Math.max(0, Math.min(1, position)) * 1000)
                if (step !== Math.round(Number(input.value) * 1000)) {
                    input.value = step / 1000
                    input.dispatchEvent(new Event('input', {bubbles:true}))
                }
            }
            input.addEventListener('pointerdown', event => {
                if (event.button !== 0 || control.drag) return
                event.preventDefault()
                dragged = false
                input.focus()
                input.setPointerCapture(event.pointerId)
                if (!control.gesture) control.gesture = host.gesture()
                const rect = input.getBoundingClientRect()
                const travel = Math.max(1, rect.height - 16)
                let position = Number(input.value)
                const thumbCenter = rect.bottom - 8 - position * travel
                // Shift always anchors at the current value, even on a track click.
                if (!event.shiftKey && Math.abs(event.clientY - thumbCenter) > 8) {
                    position = Math.max(0, Math.min(1, (rect.bottom - event.clientY - 8) / travel))
                }
                control.drag = {pointerId:event.pointerId, lastY:event.clientY, position, travel}
                writePosition(position)
            })
            input.addEventListener('pointermove', event => {
                const drag = control.drag
                if (!drag || event.pointerId !== drag.pointerId) return
                event.preventDefault()
                const distance = drag.lastY - event.clientY
                if (distance !== 0) dragged = true
                drag.lastY = event.clientY
                drag.position = Math.max(0, Math.min(1, drag.position + distance / drag.travel * (event.shiftKey ? .1 : 1)))
                writePosition(drag.position)
            })
            for (const event of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) input.addEventListener(event, end)
            input.addEventListener('click', event => {
                if (event.detail > 0 && dragged) queueMicrotask(() => input.blur())
            })
            input.addEventListener('input', () => {
                const normalized = Number(input.value)
                const number = toneValue(name, Math.round(normalized * 1000))
                const write = () => host.data.tone.set(0, { [name]:number })
                if (control.gesture) control.gesture.edit(write)
                else host.edit(write)
            })
            label.append(text, input, value)
            groups.get(group).append(label)
            this.controls.push(control)
        }
        const status = text => publishHint(host, text, true)
        this.clipboard = new ViewClipboard(host, status, 'tone',
            () => JSON.stringify({format:'deminix.tone', version:1, tone:readTone(host)}),
            text => this.applyTone(text))
        const actions = document.createElement('div')
        actions.className = 'toneActions'
        for (const [caption, action, hint] of [
            ['Shuffle', () => { host.edit(() => host.data.tone.set(0, randomTone(host.data.matrix.get(0).value))); status('Tone shuffled') }, 'Shuffle Tone'],
            ['Copy', () => this.clipboard.copy(), 'Copy Tone'], ['Paste', () => this.clipboard.paste(), 'Paste Tone']
        ]) {
            const button = document.createElement('button')
            button.type = 'button'; button.textContent = caption
            bindHint(host, button, hint)
            button.addEventListener('click', action)
            actions.append(button)
        }
        panel.append(title, controls, actions)
        host.root.append(style, panel)
        this.subscriptions.push(host.data.tone.subscribe(() => this.render()))
        this.render()
    }
    applyTone(text) {
        let parsed
        try { parsed = JSON.parse(text) } catch { return false }
        if (!parsed || parsed.format !== 'deminix.tone' || parsed.version !== 1 || !validTone(parsed.tone)) return false
        const tone = quantizedTone(parsed.tone)
        this.host.edit(() => this.host.data.tone.set(0, tone))
        return true
    }
    render() {
        const tone = readTone(this.host)
        for (const control of this.controls) {
            const value = tone[control.name]
            control.input.value = toneStep(control.name, value) / 1000
            control.value.textContent = isToneTime(control.name) ? (value < .1 ? (value * 1000).toFixed(1) + ' ms' : value.toFixed(3) + ' s') : (value * 100).toFixed(1).replace(/\.0$/, '') + '%'
            control.input.setAttribute('aria-valuetext', control.value.textContent)
        }
    }
    terminate() {
        for (const control of this.controls) if (control.gesture) control.gesture.end()
        this.clipboard.terminate()
        for (const subscription of this.subscriptions) terminateSubscription(subscription)
    }
}

// Clipboard payloads are versioned and validated completely before any writes.
class ViewClipboard {
    constructor(host, status, target, serialize, apply) {
        this.host = host
        this.status = status
        this.target = target
        this.label = {seed:"Seed", tone:"Tone", patch:"Whole patch"}[target]
        this.error = target === "seed" ? "Use nine hexadecimal digits, 0–F; spaces and 0x are allowed." : "Invalid " + target + " data; nothing changed."
        this.disposed = false
        this.serialize = serialize
        this.apply = apply
    }
    async copy() {
        if (this.disposed) return
        const text = this.serialize()
        try {
            await navigator.clipboard.writeText(text)
            if (!this.disposed) this.status(this.label + ' copied')
        } catch { if (!this.disposed) this.fallback(false, text) }
    }
    async paste() {
        if (this.disposed) return
        try {
            const text = await navigator.clipboard.readText()
            if (!this.disposed) this.applyText(text)
        } catch { if (!this.disposed) this.fallback(true, '') }
    }
    applyText(text) {
        if (this.disposed) return false
        const applied = this.apply(text)
        this.status(applied ? this.label + ' pasted' : this.error)
        return applied
    }
    close() {
        if (this.panel) this.panel.remove()
        this.panel = null
    }
    terminate() { this.disposed = true; this.close() }
    fallback(paste, text) {
        if (this.disposed) return
        this.close()
        const panel = document.createElement('div')
        this.panel = panel
        panel.style.cssText = 'position:fixed;inset:4px;z-index:10;padding:7px;border:1px solid ' + familyColor('displayStroke', .5) + ';border-radius:6px;color-scheme:dark;background:var(--family-surface);color:' + familyColor('displayStroke', 1) + ';display:flex;flex-direction:column;gap:4px;font:inherit;font-size:10px;overflow:auto'
        const label = document.createElement('label')
        label.textContent = paste ? 'Paste ' + this.target + ' (Ctrl/⌘+V):' : 'Copy ' + this.target + ' (Ctrl/⌘+C):'
        const input = document.createElement('textarea')
        input.value = text; input.readOnly = !paste; input.rows = 2
        input.setAttribute('aria-label', (this.target === 'seed' ? 'Seed' : this.target) + (paste ? ' to paste' : ' to copy'))
        input.style.cssText = 'width:100%;min-height:30px;resize:none;font:inherit;color:inherit;background:transparent;border:1px solid ' + familyColor('displayStroke', .5)
        label.append(input)
        const hint = document.createElement('div')
        hint.setAttribute('role','status')
        const actions = document.createElement('div')
        actions.style.cssText = 'display:flex;gap:4px'
        const close = () => this.close()
        const button = (text, handler) => {
            const b = document.createElement('button')
            b.type = 'button'; b.textContent = text
            b.style.cssText = 'flex:1;font:inherit;color:inherit;background:transparent;border:1px solid ' + familyColor('displayStroke', .5) + ';border-radius:3px;padding:3px'
            bindHint(this.host, b, text.startsWith('Apply') ? 'Apply ' + this.target : text === 'Cancel' ? 'Cancel paste' : 'Close clipboard')
            b.addEventListener('click', handler); actions.append(b)
        }
        if (paste) button('Apply ' + this.target, () => {
            if (this.applyText(input.value)) close()
            else hint.textContent = this.error
        })
        else input.addEventListener('copy', () => this.status(this.label + ' copied'))
        button(paste ? 'Cancel' : 'Close', close)
        panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close() } })
        panel.append(label, hint, actions); this.host.root.append(panel)
        input.focus(); input.select()
    }
}

class PatchView {
    constructor(host) {
        this.host = host
        this.subscriptions = [installFamilyTheme(host)]
        const style = document.createElement('style')
        style.textContent = `
            .patch { font-size:10px; grid-template-rows:12px 44px minmax(0,1fr) 22px; }
            .snapshotRows { display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:repeat(2,minmax(0,1fr)); gap:3px; }
            .slotLabel { width:12px; align-self:center; text-align:center; font-size:11px; }
            .patchActions > .patchRow { width:100%; min-width:0; }
            .patchActions button { min-width:0; font-size:9px; padding:3px 1px; }
            .patch button { flex:1; font:inherit; padding:4px 2px; }
            .patch button:disabled { opacity:.55; cursor:default; }
            .patch button[aria-pressed=true] { border-color:${familyColor('displayStroke', .6)}; background:${familyColor('displayStroke', .08)}; }
            .patchStatus { font-size:10px; line-height:1.25; opacity:1; min-height:0; overflow:auto; white-space:pre-line; }
        `
        const panel = document.createElement('div')
        panel.className = 'patch'
        const title = document.createElement('div')
        title.className = 'patchTitle'; title.textContent = 'PATCH'
        this.status = document.createElement('div')
        this.status.className = 'patchStatus'
        this.status.setAttribute('role','status')
        this.status._idleText = 'Hold Shift for fine adjustments\nDouble-click a matrix field to reset to 5'
        this.status.textContent = this.status._idleText
        const status = text => flashStatus(this.status, text)
        this.clipboard = new ViewClipboard(host, status, 'patch',
            () => JSON.stringify({format:'deminix.patch', version:2, matrix:this.matrixValues(), tone:readTone(host)}),
            text => this.applyPatch(text))
        const snapshots = document.createElement('div')
        snapshots.className = 'snapshotRows'
        const actions = document.createElement('div')
        actions.className = 'patchRow patchActions'
        panel.append(title, snapshots, this.status, actions)
        const row = (definitions, parent, slotLabel) => {
            const container = document.createElement('div')
            container.className = 'patchRow'
            if (slotLabel) {
                const label = document.createElement('span')
                label.className = 'slotLabel'; label.textContent = slotLabel
                container.append(label)
            }
            for (const [caption, handler, hint] of definitions) {
                const button = document.createElement('button')
                button.type = 'button'; button.textContent = caption
                bindHint(host, button, () => button.disabled ? 'Empty slot; store a patch first' : hint)
                button.addEventListener('click', handler); container.append(button)
            }
            parent.append(container)
            return container
        }
        row([['Shuffle', () => {
            host.edit(() => { const family = shuffleMatrix(host); host.data.tone.set(0, randomTone(family)) })
            status('Matrix + Tone shuffled · locks preserved')
        }, 'Shuffle patch'],
            ['Copy', () => this.clipboard.copy(), 'Copy patch'],
            ['Paste', () => this.clipboard.paste(), 'Paste patch']
        ], actions)
        this.snapshotButtons = []
        for (let slot = 0; slot < 2; slot++) {
            const name = slot === 0 ? 'A' : 'B'
            const buttons = row([
                ['Store', () => this.snapshot(slot, true), 'Store patch in ' + name],
                ['Recall', () => this.snapshot(slot, false), 'Recall patch ' + name]
            ], snapshots, name).querySelectorAll('button')
            buttons[0].setAttribute('aria-label', 'Store ' + name)
            buttons[1].setAttribute('aria-label', 'Recall ' + name)
            this.snapshotButtons.push(buttons[1])
        }
        host.root.append(style, panel)
        for (const source of [host.data.matrix, host.data.tone, host.data.snapshots]) {
            const subscription = source.subscribe(() => this.render())
            this.subscriptions.push(subscription)
        }
        this.hintRevision = -1
        const hintSubscription = host.streams.uiHints.subscribe(values => {
            if (values[0] === this.hintRevision) return
            this.hintRevision = values[0]
            let text = ''
            const length = Math.max(0, Math.min(253, Math.round(values[1])))
            for (let i = 0; i < length; i++) text += String.fromCharCode(values[i + 3])
            clearTimeout(this.status._clearTimer)
            if (values[2]) flashStatus(this.status, text)
            else {
                this.status._hintText = text
                this.status.textContent = text || this.status._idleText
            }
        })
        this.subscriptions.push(hintSubscription)
        this.render()
    }
    matrixValues() {
        const values = []
        for (let i = 0; i < 9; i++) values.push(this.host.data.matrix.get(i).value)
        return values
    }
    validMatrix(values) {
        return Array.isArray(values) && values.length === 9 && values.every(value => Number.isInteger(value) && value >= 0 && value <= 15)
    }
    restore(matrix, tone) {
        if (!this.validMatrix(matrix) || !validTone(tone)) return false
        const values = quantizedTone(tone)
        this.host.edit(() => {
            for (let i = 0; i < 9; i++) this.host.data.matrix.set(i, {value:matrix[i]})
            this.host.data.tone.set(0, values)
        })
        return true
    }
    applyPatch(text) {
        let parsed
        try { parsed = JSON.parse(text) } catch { return false }
        if (!parsed || parsed.format !== 'deminix.patch' || (parsed.version !== 1 && parsed.version !== 2)) return false
        const matrix = parsed.version === 1 ? legacyMatrix(parsed.matrix) : parsed.matrix
        return this.restore(matrix, parsed.tone)
    }
    snapshot(slot, store) {
        if (store) {
            const record = {valid:1, hex:1, ...readTone(this.host)}
            const matrix = this.matrixValues()
            for (let i = 0; i < 9; i++) record['m' + i] = matrix[i]
            this.host.edit(() => this.host.data.snapshots.set(slot, record))
        } else {
            const record = this.host.data.snapshots.get(slot)
            if (!record.valid) return
            const matrix = []
            for (let i = 0; i < 9; i++) matrix.push(record['m' + i])
            if (!this.restore(record.hex ? matrix : legacyMatrix(matrix), record)) return
        }
        flashStatus(this.status, (store ? 'Stored ' : 'Recalled ') + (slot === 0 ? 'A' : 'B'))
    }
    render() {
        const matrix = this.matrixValues()
        const tone = readTone(this.host)
        for (let slot = 0; slot < 2; slot++) {
            const record = this.host.data.snapshots.get(slot)
            const button = this.snapshotButtons[slot]
            button.disabled = !record.valid
            let same = !!record.valid
            const stored = []
            for (let i = 0; i < 9; i++) stored.push(record['m' + i])
            const expected = record.hex ? stored : legacyMatrix(stored)
            const storedTone = quantizedTone(record)
            for (let i = 0; i < 9; i++) same = same && !!expected && matrix[i] === expected[i]
            for (const name of TONE_NAMES) same = same && toneStep(name, tone[name]) === toneStep(name, storedTone[name])
            button.setAttribute('aria-pressed', String(same))
        }
    }
    terminate() {
        this.clipboard.terminate()
        clearTimeout(this.status._clearTimer)
        for (const subscription of this.subscriptions) terminateSubscription(subscription)
    }
}
