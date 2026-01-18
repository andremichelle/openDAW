import "./style.sass"
import {assert, isDefined, Nullable} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Communicator, Messenger} from "@opendaw/lib-runtime"
import {NamProcessorProtocol} from "./protocol"
import {
    computeStats,
    drawHeatmap,
    drawHistogram,
    drawLayerDiagram,
    drawWeightDistributionByLayer,
    WeightStats
} from "./visualizer"
import namWasmUrl from "@andremichelle/nam-wasm/nam.wasm?url"
import {NamModel} from "@andremichelle/nam-wasm"

const LOCAL_MODEL_URL = "/[PRE] JCM800-2203-MODIFIED-HI The Sound.nam"
const LOCAL_AUDIO_URL = "/Drop_D_Riff.mp3"

;(async () => {
    assert(crossOriginIsolated, "window must be crossOriginIsolated")
    console.log("NAM WASM Test")
    console.log("WASM URL:", namWasmUrl)

    // State
    let audioContext: Nullable<AudioContext> = null
    let namNode: Nullable<AudioWorkletNode> = null
    let sender: Nullable<NamProcessorProtocol> = null
    let audioSource: Nullable<MediaElementAudioSourceNode> = null
    let audioElement: Nullable<HTMLAudioElement> = null

    // UI references
    let statusEl: HTMLDivElement
    let loadModelBtn: HTMLButtonElement
    let startAudioBtn: HTMLButtonElement
    let modelUrlInput: HTMLInputElement

    // Visualizer references
    let statsEl: HTMLDivElement
    let histogramCanvas: HTMLCanvasElement
    let heatmapCanvas: HTMLCanvasElement
    let layerCanvas: HTMLCanvasElement
    let segmentCanvas: HTMLCanvasElement
    let vizSection: HTMLDivElement

    const setStatus = (message: string, type: "info" | "error" | "success" = "info") => {
        if (isDefined(statusEl)) {
            statusEl.textContent = message
            statusEl.className = `status ${type}`
        }
        console.log(`[Status] ${message}`)
    }

    const updateVisualizations = (model: NamModel) => {
        // Stats
        const stats: WeightStats = computeStats(model.weights)
        if (isDefined(statsEl)) {
            statsEl.innerHTML = `
                <div><strong>Model:</strong> ${model.metadata?.name || "Unknown"}</div>
                <div><strong>Architecture:</strong> ${model.architecture}</div>
                <div><strong>Version:</strong> ${model.version}</div>
                <div><strong>Weights:</strong> ${stats.count.toLocaleString()}</div>
                <div><strong>Range:</strong> [${stats.min.toFixed(4)}, ${stats.max.toFixed(4)}]</div>
                <div><strong>Mean:</strong> ${stats.mean.toFixed(6)}</div>
                <div><strong>Std Dev:</strong> ${stats.stdDev.toFixed(6)}</div>
                <div><strong>Distribution:</strong> ${stats.positive} pos, ${stats.negative} neg, ${stats.zeros} zero</div>
                ${model.metadata?.loudness ? `<div><strong>Loudness:</strong> ${model.metadata.loudness.toFixed(2)} dB</div>` : ""}
                ${model.metadata?.gain ? `<div><strong>Gain:</strong> ${model.metadata.gain.toFixed(4)}</div>` : ""}
            `
        }

        // Canvases
        if (isDefined(histogramCanvas)) {
            drawHistogram(histogramCanvas, model.weights, 150)
        }
        if (isDefined(heatmapCanvas)) {
            drawHeatmap(heatmapCanvas, model.weights, 512)
        }
        if (isDefined(layerCanvas)) {
            drawLayerDiagram(layerCanvas, model)
        }
        if (isDefined(segmentCanvas)) {
            drawWeightDistributionByLayer(segmentCanvas, model)
        }

        // Show section
        if (isDefined(vizSection)) {
            vizSection.style.display = "block"
        }
    }

    const loadModelForVisualization = async (source: string | File) => {
        try {
            let json: string
            if (typeof source === "string") {
                const response = await fetch(source)
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                json = await response.text()
            } else {
                json = await source.text()
            }
            const model: NamModel = NamModel.parse(json)
            updateVisualizations(model)
            return json
        } catch (error) {
            setStatus(`Failed to load model for visualization: ${error}`, "error")
            return null
        }
    }

    const initAudio = async () => {
        if (isDefined(audioContext)) return

        setStatus("Initializing audio context...")
        audioContext = new AudioContext()

        setStatus("Loading AudioWorklet processor...")
        await audioContext.audioWorklet.addModule(new URL("./processor.ts", import.meta.url))

        setStatus("Creating NAM processor node...")
        namNode = new AudioWorkletNode(audioContext, "nam-test-processor", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        })
        namNode.connect(audioContext.destination)

        sender = Communicator.sender<NamProcessorProtocol>(
            Messenger.for(namNode.port),
            (dispatcher): NamProcessorProtocol => ({
                initWasm(wasmBinary: ArrayBuffer) {
                    return dispatcher.dispatchAndReturn(this.initWasm, Communicator.makeTransferable(wasmBinary))
                },
                loadModel(modelJson: string) {
                    return dispatcher.dispatchAndReturn(this.loadModel, modelJson)
                },
                setInputGain(value: number) {
                    dispatcher.dispatchAndForget(this.setInputGain, value)
                },
                setOutputGain(value: number) {
                    dispatcher.dispatchAndForget(this.setOutputGain, value)
                },
                setMix(value: number) {
                    dispatcher.dispatchAndForget(this.setMix, value)
                },
                setBypass(value: boolean) {
                    dispatcher.dispatchAndForget(this.setBypass, value)
                }
            })
        )

        setStatus("Fetching WASM binary...")
        const wasmBinary = await fetch(namWasmUrl).then(response => response.arrayBuffer())

        setStatus("Initializing WASM in AudioWorklet...")
        try {
            await sender.initWasm(wasmBinary)
            setStatus("WASM ready! Load a model to continue.", "success")
            loadModelBtn.disabled = false
        } catch (error) {
            setStatus(`WASM error: ${error}`, "error")
        }
    }

    const loadModel = async () => {
        if (!isDefined(sender)) return

        const url = modelUrlInput.value.trim()
        if (!url) {
            setStatus("Please enter a model URL", "error")
            return
        }

        setStatus(`Fetching model from ${url}...`)
        try {
            const modelJson = await loadModelForVisualization(url)
            if (!isDefined(modelJson)) return

            setStatus("Sending model to processor...")
            const success = await sender.loadModel(modelJson)
            if (success) {
                setStatus("Model loaded! Click 'Play Audio' to hear it.", "success")
                startAudioBtn.disabled = false
            } else {
                setStatus("Failed to load model", "error")
            }
        } catch (error) {
            setStatus(`Failed to load model: ${error}`, "error")
        }
    }

    const toggleAudio = () => {
        if (!isDefined(audioContext) || !isDefined(namNode)) return

        if (isDefined(audioElement)) {
            if (audioElement.paused) {
                audioElement.play()
                startAudioBtn.textContent = "Stop Audio"
            } else {
                audioElement.pause()
                audioElement.currentTime = 0
                startAudioBtn.textContent = "Play Audio"
            }
            return
        }

        audioElement = new Audio(LOCAL_AUDIO_URL)
        audioElement.crossOrigin = "anonymous"
        audioElement.loop = true
        audioSource = audioContext.createMediaElementSource(audioElement)
        audioSource.connect(namNode)

        audioElement.play()
        startAudioBtn.textContent = "Stop Audio"

        if (audioContext.state === "suspended") {
            audioContext.resume()
        }
    }

    // Render UI
    replaceChildren(document.body, (
        <div class="container">
            <h1>NAM WASM Test</h1>

            <div class="section">
                <h2>Status</h2>
                <div class="status" onInit={(element: HTMLDivElement) => statusEl = element}>
                    Click "Initialize Audio" to begin
                </div>
            </div>

            <div class="section">
                <h2>Setup</h2>
                <div class="controls">
                    <div class="row">
                        <button onInit={(element: HTMLButtonElement) => {
                            element.onclick = () => initAudio()
                        }}>Initialize Audio
                        </button>
                    </div>
                </div>
            </div>

            <div class="section">
                <h2>Model</h2>
                <div class="controls">
                    <div class="row">
                        <label>Model URL</label>
                        <input
                            type="text"
                            value={LOCAL_MODEL_URL}
                            onInit={(element: HTMLInputElement) => modelUrlInput = element}
                        />
                    </div>
                    <div class="row">
                        <button
                            disabled
                            onInit={(element: HTMLButtonElement) => {
                                loadModelBtn = element
                                element.onclick = () => loadModel()
                            }}
                        >Load Model
                        </button>
                    </div>
                    <div class="row">
                        <label>Or load from file</label>
                        <input
                            type="file"
                            accept=".nam"
                            onInit={(element: HTMLInputElement) => {
                                element.onchange = async () => {
                                    const file = element.files?.[0]
                                    if (isDefined(file)) {
                                        const modelJson = await loadModelForVisualization(file)
                                        if (isDefined(modelJson) && isDefined(sender)) {
                                            setStatus("Loading model into processor...")
                                            const success = await sender.loadModel(modelJson)
                                            if (success) {
                                                setStatus("Model loaded!", "success")
                                                startAudioBtn.disabled = false
                                            }
                                        }
                                    }
                                }
                            }}
                        />
                    </div>
                </div>
            </div>

            <div class="section">
                <h2>Test</h2>
                <div class="controls">
                    <div class="row">
                        <button
                            disabled
                            onInit={(element: HTMLButtonElement) => {
                                startAudioBtn = element
                                element.onclick = () => toggleAudio()
                            }}
                        >Play Audio
                        </button>
                    </div>
                    <div class="row">
                        <label>Input Gain</label>
                        <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.01"
                            value="1"
                            onInit={(element: HTMLInputElement) => {
                                element.oninput = () => {
                                    if (isDefined(sender)) {
                                        sender.setInputGain(parseFloat(element.value))
                                    }
                                }
                            }}
                        />
                    </div>
                    <div class="row">
                        <label>Output Gain</label>
                        <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.01"
                            value="1"
                            onInit={(element: HTMLInputElement) => {
                                element.oninput = () => {
                                    if (isDefined(sender)) {
                                        sender.setOutputGain(parseFloat(element.value))
                                    }
                                }
                            }}
                        />
                    </div>
                    <div class="row">
                        <label>Mix (Dry/Wet)</label>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value="1"
                            onInit={(element: HTMLInputElement) => {
                                element.oninput = () => {
                                    if (isDefined(sender)) {
                                        sender.setMix(parseFloat(element.value))
                                    }
                                }
                            }}
                        />
                    </div>
                    <div class="row">
                        <label>Bypass</label>
                        <input
                            type="checkbox"
                            onInit={(element: HTMLInputElement) => {
                                element.onchange = () => {
                                    if (isDefined(sender)) {
                                        sender.setBypass(element.checked)
                                    }
                                }
                            }}
                        />
                    </div>
                </div>
            </div>

            <div
                class="section"
                style="display: none;"
                onInit={(element: HTMLDivElement) => vizSection = element}
            >
                <h2>Model Visualization</h2>

                <div class="viz-grid">
                    <div class="viz-panel">
                        <h3>Statistics</h3>
                        <div
                            class="stats"
                            onInit={(element: HTMLDivElement) => statsEl = element}
                        />
                    </div>

                    <div class="viz-panel">
                        <h3>Architecture</h3>
                        <canvas
                            width="600"
                            height="150"
                            onInit={(element: HTMLCanvasElement) => layerCanvas = element}
                        />
                    </div>

                    <div class="viz-panel">
                        <h3>Weight Distribution (Histogram)</h3>
                        <canvas
                            width="600"
                            height="200"
                            onInit={(element: HTMLCanvasElement) => histogramCanvas = element}
                        />
                    </div>

                    <div class="viz-panel">
                        <h3>Weight Magnitude by Segment</h3>
                        <canvas
                            width="600"
                            height="150"
                            onInit={(element: HTMLCanvasElement) => segmentCanvas = element}
                        />
                    </div>

                    <div class="viz-panel wide">
                        <h3>Weight Heatmap (Red=positive, Blue=negative)</h3>
                        <canvas
                            style="width: 100%; image-rendering: pixelated;"
                            onInit={(element: HTMLCanvasElement) => heatmapCanvas = element}
                        />
                    </div>
                </div>
            </div>

            <div class="section">
                <h2>Visualize Only (no audio)</h2>
                <div class="controls">
                    <div class="row">
                        <label>Load .nam file to visualize</label>
                        <input
                            type="file"
                            accept=".nam"
                            onInit={(element: HTMLInputElement) => {
                                element.onchange = async () => {
                                    const file = element.files?.[0]
                                    if (isDefined(file)) {
                                        await loadModelForVisualization(file)
                                        setStatus(`Visualizing: ${file.name}`, "success")
                                    }
                                }
                            }}
                        />
                    </div>
                </div>
            </div>
        </div>
    ))
})()
