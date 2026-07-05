import {createElement, PageFactory} from "@opendaw/lib-jsx"
import {MutableObservableOption} from "@opendaw/lib-std"
import {Env} from "../../Env"
import workletURL from "./engine-worklet.ts?worker&url"

const FREQUENCY = 440

// The simplest engine page: boots the bare sine.wasm oscillator into an AudioWorklet (no box graph, no device
// linking), so it has no transport, only the AudioContext. It mirrors the shared host's HUD look by hand:
// a Resume / Suspend transport reflecting the real context state, and a small readout.
export const SinePage: PageFactory<Env> = ({lifecycle}) => {
    const context = new MutableObservableOption<AudioContext>()
    const node = new MutableObservableOption<AudioWorkletNode>()
    const log: HTMLPreElement = <pre className="engine-log"/>
    const append = (line: string): void => {log.textContent = `${log.textContent ?? ""}${line}\n`}
    const led: HTMLSpanElement = <span className="engine-led"/>
    const audioStateValue: HTMLSpanElement = <span className="value">—</span>
    const frequencyValue: HTMLSpanElement = <span className="value">{String(FREQUENCY)}</span>
    const metric = (label: string, value: HTMLElement, unit: string = ""): ReadonlyArray<HTMLElement> =>
        [<span className="label">{label}</span>, value, <span className="unit">{unit}</span>]
    const resumeButton: HTMLButtonElement = <button onclick={() => void play()}>Resume</button>
    const suspendButton: HTMLButtonElement = <button onclick={() => void stop()}>Suspend</button>
    const showAudioState = (): void => {
        if (!context.nonEmpty()) {
            audioStateValue.textContent = "—"
            resumeButton.disabled = true
            suspendButton.disabled = true
            return
        }
        const {state} = context.unwrap()
        audioStateValue.textContent = state
        audioStateValue.classList.toggle("on", state === "running")
        led.classList.toggle("on", state === "running")
        resumeButton.disabled = state === "running"
        suspendButton.disabled = state !== "running"
    }
    // Boot phase: create the context, load + compile the wasm, install the worklet node (suspended).
    const boot = async (): Promise<void> => {
        const ctx = new AudioContext()
        context.wrap(ctx)
        ctx.addEventListener("statechange", () => showAudioState())
        showAudioState()
        await ctx.audioWorklet.addModule(workletURL) // vite bundles ./engine-worklet.ts and hands back its URL
        const wasm = await fetch("/wasm/sine.wasm").then(response => response.arrayBuffer())
        const module = await WebAssembly.compile(wasm)
        const workletNode = new AudioWorkletNode(ctx, "engine", {
            processorOptions: {module, sampleRate: ctx.sampleRate, frequency: FREQUENCY}
        })
        node.wrap(workletNode)
        workletNode.connect(ctx.destination)
        await ctx.suspend()
        append(`booted @ ${ctx.sampleRate} Hz — suspended`)
    }
    const play = async (): Promise<void> => {
        if (context.nonEmpty()) {await context.unwrap().resume()}
    }
    const stop = async (): Promise<void> => {
        if (context.nonEmpty()) {await context.unwrap().suspend()}
    }
    lifecycle.own({
        terminate: () => {
            node.ifSome(workletNode => workletNode.disconnect())
            context.ifSome(ctx => void ctx.close())
        }
    })
    showAudioState()
    void boot()
    return (
        <div className="page">
            <h2>Sine</h2>
            <p>Boots the bare <code>sine.wasm</code> oscillator into an AudioWorklet, then resume / suspend
                a pure tone.</p>
            <div className="engine-panel">
                <div className="engine-transport">
                    <div className="engine-id">{led}<span className="engine-title">Sine</span></div>
                    <div className="engine-buttons">{resumeButton}{suspendButton}</div>
                </div>
                <div className="engine-readout">
                    <div className="engine-grid">
                        {metric("Audio", audioStateValue)}
                        {metric("Frequency", frequencyValue, "Hz")}
                    </div>
                </div>
            </div>
            {log}
        </div>
    )
}