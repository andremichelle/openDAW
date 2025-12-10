import {Arrays, int, Terminable} from "@opendaw/lib-std"
import {Address} from "@opendaw/lib-box"
import {RenderQuantum, RMS, StereoMatrix} from "@opendaw/lib-dsp"
import {LiveStreamBroadcaster} from "@opendaw/lib-fusion"

export class PeakBroadcaster implements Terminable {
    static readonly PEAK_DECAY = Math.exp(-1.0 / (sampleRate * 0.250))
    static readonly RMS_WINDOW = Math.floor(sampleRate * 0.100)

    readonly #broadcaster: LiveStreamBroadcaster
    readonly #address: Address

    readonly #values: Float32Array
    readonly #rms: ReadonlyArray<RMS>
    readonly #terminable: Terminable

    #peakL: number = 0.0
    #peakR: number = 0.0
    #rmsL: number = 0.0
    #rmsR: number = 0.0

    constructor(broadcaster: LiveStreamBroadcaster, address: Address) {
        this.#broadcaster = broadcaster
        this.#address = address

        this.#values = new Float32Array(4)
        this.#rms = Arrays.create(() => new RMS(PeakBroadcaster.RMS_WINDOW), 2)
        this.#terminable = this.#broadcaster.broadcastFloats(this.#address, this.#values, (_hasSubscribers) => {
            this.#values[0] = this.#peakL
            this.#values[1] = this.#peakR
            this.#values[2] = this.#rmsL
            this.#values[3] = this.#rmsR
        })
    }

    clear(): void {
        this.#rms[0].clear()
        this.#rms[1].clear()
        this.#peakL = 0.0
        this.#peakR = 0.0
    }

    process(outL: Float32Array, outR: Float32Array, fromIndex: int = 0, toIndex: int = RenderQuantum): void {
        const samples = toIndex - fromIndex
        const decay = PeakBroadcaster.PEAK_DECAY ** samples
        let maxL = 0.0
        let maxR = 0.0
        for (let i = fromIndex; i < toIndex; i++) {
            const l = Math.abs(outL[i])
            const r = Math.abs(outR[i])
            if (l > maxL) maxL = l
            if (r > maxR) maxR = r
        }
        this.#peakL = Math.max(maxL, this.#peakL * decay)
        this.#peakR = Math.max(maxR, this.#peakR * decay)
        this.#rmsL = this.#rms[0].processBlock(outL, fromIndex, toIndex)
        this.#rmsR = this.#rms[1].processBlock(outR, fromIndex, toIndex)
    }

    processStereo([l, r]: StereoMatrix.Channels, fromIndex: int = 0, toIndex: int = RenderQuantum): void {
        this.process(l, r, fromIndex, toIndex)
    }

    terminate(): void {this.#terminable.terminate()}
}