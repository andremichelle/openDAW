import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {MutableObservableOption} from "@opendaw/lib-std"
import {Env} from "../../Env"
import workletURL from "./engine-worklet.ts?worker&url"

// Step 1: boot the wasm engine into an AudioWorklet (install), then play/stop a sine.
export const SinePage: PageFactory<Env> = ({lifecycle}) => {
    const context = new MutableObservableOption<AudioContext>()
    const node = new MutableObservableOption<AudioWorkletNode>()
    const log: HTMLPreElement = <pre/>
    const append = (line: string): void => {log.textContent = `${log.textContent ?? ""}${line}\n`}

    // Boot phase: create the context, load + compile the wasm, install the worklet node (suspended).
    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        await ctx.audioWorklet.addModule(workletURL) // vite bundles ./engine-worklet.ts and hands back its URL
        const wasm = await fetch("/sine.wasm").then(response => response.arrayBuffer())
        const module = await WebAssembly.compile(wasm)
        const workletNode = new AudioWorkletNode(ctx, "engine", {
            processorOptions: {module, sampleRate: ctx.sampleRate, frequency: 440}
        })
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        await ctx.suspend()
        append(`booted @ ${ctx.sampleRate} Hz — suspended`)
    }

    const play = async (): Promise<void> => {
        if (context.nonEmpty()) {
            await context.unwrap().resume()
            append("playing")
        }
    }
    const stop = async (): Promise<void> => {
        if (context.nonEmpty()) {
            await context.unwrap().suspend()
            append("suspended")
        }
    }

    lifecycle.own({
        terminate: () => {
            node.ifSome(workletNode => workletNode.disconnect())
            context.ifSome(ctx => void ctx.close())
        }
    })
    void boot()
    return (
        <div className="page">
            <h2>Sine — 440 Hz</h2>
            <p>Boots the wasm engine into an AudioWorklet (install), then play / stop.</p>
            <button onclick={() => void play()}>▶ Play</button>
            <button onclick={() => void stop()}>■ Stop</button>
            {log}
        </div>
    )
}