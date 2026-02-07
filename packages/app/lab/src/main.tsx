import "./style.sass"
import { assert, DefaultParameter, StringMapping, Terminator, ValueMapping } from "@opendaw/lib-std"
import { createElement, replaceChildren } from "@opendaw/lib-jsx"
import { Communicator, Messenger } from "@opendaw/lib-runtime"
import { Slider } from "./Slider"
import { Protocol } from "./protocol"
import { Waveform } from "./waveform"
import { Oscilloscope } from "./Oscilloscope"

(async () => {
    assert(crossOriginIsolated, "window must be crossOriginIsolated")
    console.debug("openDAW Lab")

    const audioContext = new AudioContext()
    await audioContext.suspend()
    await audioContext.audioWorklet.addModule(new URL("./processor.ts", import.meta.url))
    const oscillatorNode = new AudioWorkletNode(audioContext, "proc-osc-polyblip")
    oscillatorNode.connect(audioContext.destination)

    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 4096
    analyser.smoothingTimeConstant = 0
    oscillatorNode.connect(analyser)
    analyser.connect(audioContext.destination)

    const lifeCycle = new Terminator()

    const commands = Communicator.sender<Protocol>(Messenger.for(oscillatorNode.port), dispatcher => ({
        setWaveform(value: number) { dispatcher.dispatchAndForget(this.setWaveform, value) },
        setFrequency(value: number) { dispatcher.dispatchAndForget(this.setFrequency, value) }
    }))

    const waveforms: ReadonlyArray<Waveform> = Object.values(Waveform).filter(v => typeof v === "number")

    const waveform = new DefaultParameter(
        ValueMapping.values(waveforms),
        StringMapping.values("", waveforms, Object.keys(Waveform)), "Frequency", Waveform.SINE)

    const frequency = new DefaultParameter(
        ValueMapping.exponential(20, 20000),
        StringMapping.numeric(), "Frequency", 200.0)

    lifeCycle.ownAll(
        waveform.catchupAndSubscribe(owner => commands.setWaveform(owner.getValue())),
        frequency.catchupAndSubscribe(owner => commands.setFrequency(owner.getValue()))
    )

    replaceChildren(document.body, (
        <div>
            <span>Run</span>
            <input type="checkbox" aria-label="Run Audio Context" onInit={element => {
                element.onchange = () => {
                    if (audioContext.state === "suspended") {
                        element.value = "true"
                        audioContext.resume()
                    } else {
                        element.value = "false"
                        audioContext.suspend()
                    }
                }
            }} />
            <span>Waveform</span>
            <Slider lifecycle={lifeCycle} parameter={waveform} />
            <span>Frequency</span>
            <Slider lifecycle={lifeCycle} parameter={frequency} />
            <div style="margin-top: 30px;">
                <Oscilloscope analyser={analyser} lifecycle={lifeCycle} />
            </div>
        </div>
    ))
})()