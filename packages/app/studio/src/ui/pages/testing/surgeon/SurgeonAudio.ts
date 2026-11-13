import {int, Observer, Subscription, Terminable} from "@opendaw/lib-std"
import {SurgeonModel} from "@/ui/pages/testing/surgeon/SurgeonModel"

// the preview plays through the real engine core (crates/stock-devices/device-surgeon), built as surgeon_wasm.wasm
export namespace SurgeonAudio {
    export const NoSlot = -2
    export const Off = -1

    export type Report = { readonly pulses: number, readonly active: int, readonly fired: int }
    export type Player = Terminable & {
        readonly pattern: (index: int, pattern: SurgeonModel.Pattern) => void
        readonly fire: (slot: int) => void
        readonly play: (playing: boolean) => void
        readonly tune: (midi: number) => void
        readonly volume: (gain: number) => void
        readonly subscribe: (observer: Observer<Report>) => Subscription
    }

    const ModuleUrl = `${import.meta.env.BASE_URL}wasm-engine/wasm/surgeon_wasm.wasm`
    const WorkletUrl = new URL("./SurgeonWorklet.js", import.meta.url).href

    // the order `set_pattern` in crates/surgeon-wasm reads
    const flatten = ({rate, pitch, lanes, base, amounts}: SurgeonModel.Pattern): Float32Array => Float32Array.from([
        rate, pitch.steps, pitch.seed, pitch.mutate, pitch.range, pitch.density, pitch.tie, pitch.accent, pitch.slide,
        ...lanes.flatMap(({steps, seed, mutate}) => [steps, seed, mutate]), ...base, ...amounts.flat()
    ])

    export const load = async (context: AudioContext, bpm: number): Promise<Player> => {
        const response = await fetch(ModuleUrl)
        if (!response.ok) {return Promise.reject(new Error(`Could not load ${ModuleUrl} (${response.status})`))}
        const module = await response.arrayBuffer()
        await context.audioWorklet.addModule(WorkletUrl)
        const node = new AudioWorkletNode(context, "surgeon-preview", {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: {module, bpm}
        })
        node.connect(context.destination)
        const observers = new Set<Observer<Report>>()
        node.port.onmessage = ({data}: MessageEvent<Report>) => observers.forEach(observer => observer(data))
        return {
            pattern: (index, pattern) => node.port.postMessage({type: "pattern", index, values: flatten(pattern)}),
            fire: slot => node.port.postMessage({type: "fire", slot}),
            play: playing => node.port.postMessage({type: "play", playing}),
            tune: midi => node.port.postMessage({type: "tune", midi}),
            volume: gain => node.port.postMessage({type: "volume", gain}),
            subscribe: observer => {
                observers.add(observer)
                return {terminate: () => observers.delete(observer)}
            },
            terminate: () => {
                node.port.postMessage({type: "stop"})
                node.disconnect()
                observers.clear()
            }
        }
    }
}
