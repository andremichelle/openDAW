import "./style.sass"
import {assert, isDefined, Nullable} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import namWasmUrl from "@andremichelle/nam-wasm/nam.wasm?url"

const LOCAL_MODEL_URL = "/[PRE] JCM800-2203-MODIFIED-HI The Goods.nam"
const LOCAL_AUDIO_URL = "/Drop_D_Riff.mp3"

;(async () => {
    assert(crossOriginIsolated, "window must be crossOriginIsolated")
    console.log("NAM WASM Test")
    console.log("WASM URL:", namWasmUrl)

    // State
    let audioContext: Nullable<AudioContext> = null
    let namNode: Nullable<AudioWorkletNode> = null
    let audioSource: Nullable<MediaElementAudioSourceNode> = null
    let audioElement: Nullable<HTMLAudioElement> = null
    let wasmReady = false
    let modelLoaded = false

    // UI references
    let statusEl: HTMLDivElement
    let loadModelBtn: HTMLButtonElement
    let startAudioBtn: HTMLButtonElement
    let modelUrlInput: HTMLInputElement

    const setStatus = (message: string, type: "info" | "error" | "success" = "info") => {
        if (isDefined(statusEl)) {
            statusEl.textContent = message
            statusEl.className = `status ${type}`
        }
        console.log(`[Status] ${message}`)
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

        // Listen for messages from processor
        namNode.port.onmessage = (event) => {
            const {type} = event.data
            if (type === "wasm-ready") {
                wasmReady = true
                setStatus("WASM ready! Load a model to continue.", "success")
                loadModelBtn.disabled = false
            } else if (type === "model-loaded") {
                modelLoaded = event.data.success
                if (modelLoaded) {
                    setStatus("Model loaded! Click 'Play Audio' to hear it.", "success")
                    startAudioBtn.disabled = false
                } else {
                    setStatus(`Failed to load model: ${event.data.error || "unknown error"}`, "error")
                }
            } else if (type === "wasm-error") {
                setStatus(`WASM error: ${event.data.error}`, "error")
            }
        }

        setStatus("Fetching WASM binary...")
        const wasmBinary = await fetch(namWasmUrl).then(response => response.arrayBuffer())

        setStatus("Initializing WASM in AudioWorklet...")
        namNode.port.postMessage({type: "init-wasm", wasmBinary}, [wasmBinary])
    }

    const loadModel = async () => {
        if (!isDefined(namNode) || !wasmReady) return

        const url = modelUrlInput.value.trim()
        if (!url) {
            setStatus("Please enter a model URL", "error")
            return
        }

        setStatus(`Fetching model from ${url}...`)
        try {
            const response = await fetch(url)
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }
            const modelJson = await response.text()
            setStatus("Sending model to processor...")
            namNode.port.postMessage({type: "load-model", modelJson})
        } catch (error) {
            setStatus(`Failed to fetch model: ${error}`, "error")
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

        // Create audio element and connect
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
                        }}>Initialize Audio</button>
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
                        >Load Model</button>
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
                        >Play Audio</button>
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
                                    if (isDefined(namNode)) {
                                        namNode.port.postMessage({type: "set-input-gain", value: parseFloat(element.value)})
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
                                    if (isDefined(namNode)) {
                                        namNode.port.postMessage({type: "set-output-gain", value: parseFloat(element.value)})
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
                                    if (isDefined(namNode)) {
                                        namNode.port.postMessage({type: "set-mix", value: parseFloat(element.value)})
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
                                    if (isDefined(namNode)) {
                                        namNode.port.postMessage({type: "set-bypass", value: element.checked})
                                    }
                                }
                            }}
                        />
                    </div>
                </div>
            </div>

            <div class="section">
                <h2>Notes</h2>
                <ul style="padding-left: 20px; color: #888; font-size: 14px;">
                    <li>Local JCM800 model + clean guitar audio are pre-loaded</li>
                    <li>Get more NAM models from <a href="https://www.tone3000.com/" target="_blank" style="color: #4a9eff;">TONE3000</a></li>
                    <li>Models are .nam files (JSON format)</li>
                    <li>NAM processes mono audio - stereo input is mixed to mono</li>
                </ul>
            </div>
        </div>
    ))
})()
