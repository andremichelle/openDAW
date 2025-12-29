import css from "./TestPage.sass?inline"
import {createElement, PageContext, PageFactory} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {Html} from "@opendaw/lib-dom"

const FMRadioProcessorUrl = new URL("./test/FMRadioProcessor.ts", import.meta.url)

const className = Html.adoptStyleSheet(css, "TestPage")

// Audio file to load
const AUDIO_URL = "https://api.opendaw.studio/music/uploads/3a96772867c/mixdown.mp3"

// Default parameter values (matching processor)
const DEFAULT_FREQUENCY_OFFSET = 0.0
const DEFAULT_CARRIER_FREQUENCY = 10000.0
const DEFAULT_MODULATION_INDEX = 5.0
const DEFAULT_OFFSET_RANGE = 500.0
const DEFAULT_NOISE_AMOUNT = 0.8

type FMRadioState = {
    audioContext: AudioContext | null
    workletNode: AudioWorkletNode | null
    sourceNode: AudioBufferSourceNode | null
    audioBuffer: AudioBuffer | null
    isPlaying: boolean
}

const createSlider = (
    label: string,
    min: number,
    max: number,
    step: number,
    defaultValue: number,
    unit: string,
    onChange: (value: number) => void
): HTMLElement => {
    const valueDisplay: HTMLSpanElement = <span>{defaultValue.toFixed(2)} {unit}</span>
    const slider: HTMLInputElement = (
        <input
            type="range"
            min={min.toString()}
            max={max.toString()}
            step={step.toString()}
            value={defaultValue.toString()}
        />
    )
    slider.addEventListener("input", () => {
        const value = parseFloat(slider.value)
        valueDisplay.textContent = `${value.toFixed(2)} ${unit}`
        onChange(value)
    })
    return (
        <div className="control">
            <label>{label}</label>
            {slider}
            {valueDisplay}
        </div>
    )
}

export const TestPage: PageFactory<StudioService> = ({lifecycle}: PageContext<StudioService>) => {
    const state: FMRadioState = {
        audioContext: null,
        workletNode: null,
        sourceNode: null,
        audioBuffer: null,
        isPlaying: false
    }

    const statusEl: HTMLElement = <div className="status">Click "Initialize Audio" to start</div>

    const setStatus = (text: string) => {
        statusEl.textContent = text
    }

    const initAudio = async () => {
        try {
            setStatus("Creating AudioContext...")
            state.audioContext = new AudioContext()

            setStatus("Loading worklet module...")
            await state.audioContext.audioWorklet.addModule(FMRadioProcessorUrl)

            setStatus("Fetching audio file...")
            const response = await fetch(AUDIO_URL)
            const arrayBuffer = await response.arrayBuffer()

            setStatus("Decoding audio...")
            state.audioBuffer = await state.audioContext.decodeAudioData(arrayBuffer)

            setStatus("Creating worklet node...")
            state.workletNode = new AudioWorkletNode(state.audioContext, "fm-radio-processor", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                channelCount: 2,
                outputChannelCount: [2]
            })

            // Connect worklet to destination
            state.workletNode.connect(state.audioContext.destination)

            setStatus("Ready! Click Play to start.")
        } catch (error) {
            setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
            console.error("Init error:", error)
        }
    }

    const play = () => {
        if (!state.audioContext || !state.workletNode || !state.audioBuffer) {
            setStatus("Please initialize audio first")
            return
        }

        if (state.isPlaying && state.sourceNode) {
            state.sourceNode.stop()
        }

        state.sourceNode = state.audioContext.createBufferSource()
        state.sourceNode.buffer = state.audioBuffer
        state.sourceNode.loop = true
        state.sourceNode.connect(state.workletNode)
        state.sourceNode.start()
        state.isPlaying = true
        setStatus("Playing...")
    }

    const stop = () => {
        if (state.sourceNode && state.isPlaying) {
            state.sourceNode.stop()
            state.isPlaying = false
            setStatus("Stopped")
        }
    }

    const setParam = (name: string, value: number) => {
        if (state.workletNode) {
            const param = state.workletNode.parameters.get(name)
            if (param) {
                param.value = value
            }
        }
    }

    // Cleanup on page leave
    lifecycle.own({
        terminate: () => {
            if (state.sourceNode) {
                try { state.sourceNode.stop() } catch { /* ignore */ }
            }
            if (state.audioContext) {
                state.audioContext.close()
            }
        }
    })

    return (
        <div className={className}>
            <h1>FM Radio Tuning Effect</h1>

            {statusEl}

            <div className="buttons">
                <button onclick={initAudio}>Initialize Audio</button>
                <button onclick={play}>Play</button>
                <button onclick={stop}>Stop</button>
            </div>

            <div className="controls">
                <h2>Parameters</h2>
                {createSlider(
                    "Frequency Offset",
                    0.0, 1.0, 0.01,
                    DEFAULT_FREQUENCY_OFFSET,
                    "",
                    (v) => setParam("frequencyOffset", v)
                )}
                {createSlider(
                    "Carrier Frequency",
                    1000, 20000, 100,
                    DEFAULT_CARRIER_FREQUENCY,
                    "Hz",
                    (v) => setParam("carrierFrequency", v)
                )}
                {createSlider(
                    "Modulation Index",
                    0.1, 20.0, 0.1,
                    DEFAULT_MODULATION_INDEX,
                    "",
                    (v) => setParam("modulationIndex", v)
                )}
                {createSlider(
                    "Offset Range",
                    10, 2000, 10,
                    DEFAULT_OFFSET_RANGE,
                    "Hz",
                    (v) => setParam("offsetRange", v)
                )}
                {createSlider(
                    "Noise Amount",
                    0.0, 1.0, 0.01,
                    DEFAULT_NOISE_AMOUNT,
                    "",
                    (v) => setParam("noiseAmount", v)
                )}
            </div>
        </div>
    )
}
