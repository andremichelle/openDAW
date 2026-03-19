// Simple Delay
// @param time 0.5 0.001 2.0 exp s
// @param feedback 0.5 0 0.95 linear

class Processor {
    bufferL = new Float32Array(sampleRate * 2)
    bufferR = new Float32Array(sampleRate * 2)
    writeHead = 0
    delaySamples = sampleRate * 0.5
    feedback = 0.5
    paramChanged(label, value) {
        if (label === "time") this.delaySamples = Math.round(value * sampleRate)
        if (label === "feedback") this.feedback = value
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        for (let i = s0; i < s1; i++) {
            const readHead = (this.writeHead - this.delaySamples + this.bufferL.length) % this.bufferL.length
            const delayedL = this.bufferL[readHead]
            const delayedR = this.bufferR[readHead]
            this.bufferL[this.writeHead] = srcL[i] + delayedL * this.feedback
            this.bufferR[this.writeHead] = srcR[i] + delayedR * this.feedback
            this.writeHead = (this.writeHead + 1) % this.bufferL.length
            outL[i] = srcL[i] + delayedL
            outR[i] = srcR[i] + delayedR
        }
    }
}