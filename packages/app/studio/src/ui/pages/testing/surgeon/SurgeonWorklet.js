// runs surgeon_wasm.wasm (the real engine core) on its own clock and reports position and playing slot to the page
const ReportEveryBlocks = 4

class SurgeonProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super()
        const {module, bpm} = options.processorOptions
        this.engine = new WebAssembly.Instance(new WebAssembly.Module(module), {}).exports
        this.engine.init(sampleRate)
        this.patternFloats = this.engine.pattern_floats()
        this.pattern = this.engine.alloc_floats(this.patternFloats)
        this.output = this.engine.alloc_floats(128)
        this.bpm = bpm
        this.playing = false
        this.alive = true
        this.pulses = 0.0
        this.blocks = 0
        this.port.onmessage = ({data}) => {
            if (data.type === "pattern") {
                new Float32Array(this.engine.memory.buffer, this.pattern, this.patternFloats).set(data.values)
                this.engine.set_pattern(data.index, this.pattern)
            } else if (data.type === "fire") {
                if (this.playing) {this.engine.fire(data.slot)} else {this.engine.select(data.slot)}
            } else if (data.type === "play") {
                this.playing = data.playing
                this.pulses = 0.0
                const waiting = this.engine.fired()
                if (!this.playing && waiting !== -2) {this.engine.select(waiting)}
            } else if (data.type === "stop") {
                this.alive = false
            } else if (data.type === "tune") {
                this.engine.set_tune(data.midi)
            } else if (data.type === "volume") {
                this.engine.set_volume(data.gain)
            }
        }
    }

    process(_inputs, outputs) {
        if (!this.alive) {return false}
        const channels = outputs[0]
        const frames = channels[0].length
        const advance = this.playing ? frames * this.bpm / 60.0 * 960.0 / sampleRate : 0.0
        this.engine.process(this.pulses, this.pulses + advance, this.playing ? 1 : 0, 0, this.output, frames)
        const rendered = new Float32Array(this.engine.memory.buffer, this.output, frames)
        channels.forEach(channel => channel.set(rendered))
        this.pulses += advance
        if (++this.blocks % ReportEveryBlocks === 0) {
            this.port.postMessage({pulses: this.pulses, active: this.engine.active(), fired: this.engine.fired()})
        }
        return true
    }
}

registerProcessor("surgeon-preview", SurgeonProcessor)
