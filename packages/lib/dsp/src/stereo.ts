import {clamp, int, PI_QUART} from "@moises-ai/lib-std"
import {Mixing} from "./mixing"

export namespace StereoMatrix {
    export type Matrix = {
        ll: number // L -> L
        rl: number // R -> L
        lr: number // L -> R
        rr: number // R -> R
    }
    export type Params = {
        gain: number
        panning: number   // -1 (left) to +1 (right)
        stereo: number      // -1 (mono) to 0 (neutral) to +1 (increased width)
        invertL: boolean
        invertR: boolean
        swap: boolean
    }

    export type Channels = [Float32Array, Float32Array]

    export const zero = (): Matrix => ({ll: 0.0, lr: 0.0, rl: 0.0, rr: 0.0})
    export const identity = (): Matrix => ({ll: 1.0, lr: 0.0, rl: 0.0, rr: 1.0})
    export const update = (m: Matrix,
                           {gain, panning, invertL, invertR, stereo, swap}: Params,
                           mixing: Mixing = Mixing.EqualPower): void => {
        const [panL, panR] = panningToGains(panning, mixing)
        let lGain = panL * gain
        let rGain = panR * gain
        if (invertL) lGain *= -1.0
        if (invertR) rGain *= -1.0
        const mono = Math.max(0.0, -stereo)
        const expand = Math.max(0.0, stereo)
        const midGain = 1.0 - expand
        const sideGain = 1.0 + expand
        const monoAmount = mono * 0.5
        const stereoWidth = 1.0 - mono
        const m00 = (midGain + sideGain) * 0.5
        const m01 = (midGain - sideGain) * 0.5
        const m10 = (midGain - sideGain) * 0.5
        const m11 = (midGain + sideGain) * 0.5
        const ll = (lGain * (monoAmount + stereoWidth)) * m00 + (rGain * monoAmount) * m01
        const rl = (lGain * (monoAmount + stereoWidth)) * m10 + (rGain * monoAmount) * m11
        const lr = (lGain * monoAmount) * m00 + (rGain * (monoAmount + stereoWidth)) * m01
        const rr = (lGain * monoAmount) * m10 + (rGain * (monoAmount + stereoWidth)) * m11
        if (swap) {
            m.ll = rl
            m.rl = ll
            m.lr = rr
            m.rr = lr
        } else {
            m.ll = ll
            m.lr = lr
            m.rl = rl
            m.rr = rr
        }
    }

    export const panningToGains = (panning: number, mixing: Mixing): [number, number] => {
        const x = clamp(panning, -1.0, 1.0)
        switch (mixing) {
            case Mixing.Linear:
                return [
                    Math.min(1.0 - x, 1.0),
                    Math.min(x + 1.0, 1.0)
                ]
            case Mixing.EqualPower:
                return [
                    Math.cos((x + 1.0) * PI_QUART),
                    Math.sin((x + 1.0) * PI_QUART)
                ]
        }
    }

    export const applyFrame = (m: Matrix, l: number, r: number): [number, number] =>
        [m.ll * l + m.rl * r, m.lr * l + m.rr * r]

    export const processFrames = (m: Matrix,
                                  source: Channels, target: Channels,
                                  fromIndex: int, toIndex: int): void => {
        const [src0, src1] = source
        const [trg0, trg1] = target
        for (let i = fromIndex; i < toIndex; i++) {
            const l = src0[i]
            const r = src1[i]
            trg0[i] = m.ll * l + m.rl * r
            trg1[i] = m.lr * l + m.rr * r
        }
    }

    export const replaceFrames = (m: Matrix, [ch0, ch1]: Channels, fromIndex: int, toIndex: int): void => {
        for (let i = fromIndex; i < toIndex; i++) {
            const l = ch0[i]
            const r = ch1[i]
            ch0[i] = m.ll * l + m.rl * r
            ch1[i] = m.lr * l + m.rr * r
        }
    }
}