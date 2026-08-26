import {clamp, int, isDefined, Nullable} from "@opendaw/lib-std"
import {Transient} from "./detector"
import {LoadedSample} from "./samples"

interface Marker {
    position: number // source SAMPLES
    strength: number // [0, 1]
}

export interface TransientViewOptions {
    sample: LoadedSample
    detected: ReadonlyArray<Transient>
    context: AudioContext
}

export interface TransientView {
    readonly element: HTMLElement
    dispose(): void
}

const COLOR_WAVE = "#3a4a5a"
const COLOR_DETECTED = "#46c6ff"
const COLOR_COMPARISON = "#ff9d3b" // a loaded `.transients.json` overlay (old-vs-new detector A/B)
const COLOR_SELECTED = "#ffe14d"
const COLOR_PLAYHEAD = "#ffffff"
const HIT_PX = 6
const MIN_VIEW = 64

export const createTransientView = (options: TransientViewOptions): TransientView => {
    const {sample, detected, context} = options
    const {audio} = sample
    const frames = audio.numberOfFrames
    const sampleRate = audio.sampleRate

    // Mono mix for waveform display.
    const mono = new Float32Array(frames)
    {
        const channels = audio.numberOfChannels
        for (let channel = 0; channel < channels; channel++) {
            const data = audio.frames[channel]
            for (let index = 0; index < frames; index++) {mono[index] += data[index] / channels}
        }
    }

    // Editable marker copy (positions in samples), sorted by position.
    const markers: Array<Marker> = detected
        .map(transient => ({position: Math.round(transient.position * sampleRate), strength: transient.strength}))
        .sort((a, b) => a.position - b.position)
    let maxStrength = 0
    for (const marker of markers) {maxStrength = Math.max(maxStrength, marker.strength)}
    // A comparison marker set (source SAMPLES) loaded on demand from a `.transients.json` export — for
    // eyeballing the OLD detector's markers against the current (new) live detection on the same waveform.
    let comparison: Nullable<Int32Array> = null
    let edited = false

    // Playback buffer (copy channels out of SharedArrayBuffer into a plain AudioBuffer).
    let audioBuffer: Nullable<AudioBuffer> = null
    const getAudioBuffer = (): AudioBuffer => {
        if (isDefined(audioBuffer)) {return audioBuffer}
        const buffer = context.createBuffer(audio.numberOfChannels, frames, sampleRate)
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
            buffer.copyToChannel(new Float32Array(audio.frames[channel]), channel)
        }
        audioBuffer = buffer
        return buffer
    }

    // View state.
    let viewStart = 0
    let viewLength = frames
    let hoverIndex = -1
    let selectedIndex = -1
    let dirty = true
    const show = {wave: true, detected: true, comparison: false}

    type Playing = {source: AudioBufferSourceNode, start: number, end: number, at: number}
    let playing: Nullable<Playing> = null
    let lastSlice: Nullable<[number, number]> = null

    // DOM.
    const element = document.createElement("div")
    element.className = "view"

    const toolbar = document.createElement("div")
    toolbar.className = "toolbar"

    const makeToggle = (text: string, key: keyof typeof show): HTMLLabelElement => {
        const label = document.createElement("label")
        const input = document.createElement("input")
        input.type = "checkbox"
        input.checked = show[key]
        input.disabled = false
        input.onchange = () => {show[key] = input.checked; invalidate()}
        label.append(input, document.createTextNode(text))
        return label
    }

    const resetButton = document.createElement("button")
    resetButton.textContent = "Reset edits"
    resetButton.onclick = () => {
        markers.length = 0
        detected.forEach(transient =>
            markers.push({position: Math.round(transient.position * sampleRate), strength: transient.strength}))
        markers.sort((a, b) => a.position - b.position)
        selectedIndex = -1
        edited = false
        invalidate()
    }

    const zoomFitButton = document.createElement("button")
    zoomFitButton.textContent = "Zoom fit"
    zoomFitButton.onclick = () => {viewStart = 0; viewLength = frames; invalidate()}

    const exportButton = document.createElement("button")
    exportButton.textContent = "Export JSON"
    exportButton.onclick = () => exportJson()

    // Comparison overlay: toggle is disabled until a `.transients.json` is loaded via the button next to it.
    const comparisonCheckbox = document.createElement("input")
    comparisonCheckbox.type = "checkbox"
    comparisonCheckbox.disabled = true
    comparisonCheckbox.onchange = () => {show.comparison = comparisonCheckbox.checked; invalidate()}
    const comparisonToggle = document.createElement("label")
    comparisonToggle.append(comparisonCheckbox, document.createTextNode("comparison"))

    const comparisonFile = document.createElement("input")
    comparisonFile.type = "file"
    comparisonFile.accept = "application/json,.json"
    comparisonFile.style.display = "none"
    comparisonFile.onchange = () => {
        const file = comparisonFile.files?.[0]
        if (!isDefined(file)) {return}
        file.text().then(text => {
            const json = JSON.parse(text) as {markers?: ReadonlyArray<{sample?: number, seconds?: number}>}
            const positions = (json.markers ?? [])
                .map(marker => isDefined(marker.sample) ? marker.sample : Math.round((marker.seconds ?? 0) * sampleRate))
                .filter(position => Number.isFinite(position))
                .sort((a, b) => a - b)
            comparison = Int32Array.from(positions)
            comparisonCheckbox.disabled = false
            comparisonCheckbox.checked = true
            show.comparison = true
            invalidate()
        }).catch(error => console.error("comparison json load failed", error))
        comparisonFile.value = ""
    }
    const loadComparisonButton = document.createElement("button")
    loadComparisonButton.textContent = "Load comparison…"
    loadComparisonButton.onclick = () => comparisonFile.click()

    toolbar.append(
        makeToggle("waveform", "wave"),
        makeToggle("detected", "detected"),
        comparisonToggle, loadComparisonButton, comparisonFile,
        zoomFitButton, resetButton, exportButton)

    const canvas = document.createElement("canvas")
    canvas.className = "wave"
    canvas.tabIndex = 0

    const status = document.createElement("div")
    status.className = "status"

    const help = document.createElement("div")
    help.className = "help"
    help.innerHTML =
        "<kbd>click</kbd> play slice · <kbd>drag</kbd> move marker · <kbd>dbl-click</kbd> add · " +
        "<kbd>right-click</kbd> delete · <kbd>wheel</kbd> zoom · <kbd>shift+wheel</kbd> pan · " +
        "<kbd>←/→</kbd> nudge selected · <kbd>space</kbd> replay"

    element.append(toolbar, canvas, status, help)

    const invalidate = (): void => {dirty = true}

    // Coordinate mapping (CSS pixels).
    const cssWidth = (): number => canvas.clientWidth
    const cssHeight = (): number => canvas.clientHeight
    const sampleToX = (position: number): number => (position - viewStart) / viewLength * cssWidth()
    const xToSample = (x: number): number => viewStart + x / cssWidth() * viewLength

    const nearestMarker = (x: number): int => {
        let best = -1
        let bestDist = HIT_PX
        for (let index = 0; index < markers.length; index++) {
            const distance = Math.abs(sampleToX(markers[index].position) - x)
            if (distance < bestDist) {bestDist = distance; best = index}
        }
        return best
    }

    // Slice [start, end) surrounding a sample position (using the detected/edited markers).
    const sliceAt = (position: number): [number, number] => {
        let start = 0
        let end = frames
        for (const marker of markers) {
            if (marker.position <= position) {start = marker.position} else {end = marker.position; break}
        }
        return [start, end]
    }

    const stopPlayback = (): void => {
        if (isDefined(playing)) {
            playing.source.onended = null
            playing.source.stop()
            playing = null
        }
    }

    const play = (start: number, end: number): void => {
        stopPlayback()
        if (context.state === "suspended") {void context.resume()}
        const source = context.createBufferSource()
        source.buffer = getAudioBuffer()
        source.connect(context.destination)
        const startSeconds = start / sampleRate
        const duration = Math.max(0, (end - start) / sampleRate)
        source.start(0, startSeconds, duration)
        const current: Playing = {source, start, end, at: context.currentTime}
        source.onended = () => {if (playing === current) {playing = null; invalidate()}}
        playing = current
        lastSlice = [start, end]
        invalidate()
    }

    const exportJson = (): void => {
        const data = {
            file: sample.name,
            sampleRate,
            numberOfFrames: frames,
            analyzerVersion: 1,
            edited,
            markers: markers.map(marker => ({
                sample: marker.position,
                seconds: marker.position / sampleRate,
                strength: marker.strength
            }))
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"})
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = sample.name.replace(/\.wav$/i, "") + ".transients.json"
        anchor.click()
        URL.revokeObjectURL(url)
    }

    const setStatus = (): void => {
        const parts: Array<string> = []
        parts.push(`detected/edited: ${markers.length}`)
        if (isDefined(comparison)) {parts.push(`comparison: ${comparison.length}`)}
        parts.push(`view: ${(viewLength / sampleRate * 1000).toFixed(0)}ms`)
        if (selectedIndex >= 0 && selectedIndex < markers.length) {
            const marker = markers[selectedIndex]
            const next = selectedIndex + 1 < markers.length ? markers[selectedIndex + 1].position : frames
            const gap = ((next - marker.position) / sampleRate * 1000).toFixed(1)
            parts.push(`selected #${selectedIndex}: ${(marker.position / sampleRate).toFixed(4)}s ` +
                `strength ${marker.strength.toFixed(2)} slice ${gap}ms`)
        } else if (hoverIndex >= 0) {
            const marker = markers[hoverIndex]
            parts.push(`#${hoverIndex}: ${(marker.position / sampleRate).toFixed(4)}s strength ${marker.strength.toFixed(2)}`)
        }
        if (edited) {parts.push("● edited")}
        status.innerHTML = "<b>" + sample.name + "</b>   " + parts.join("   ")
    }

    // Rendering.
    const draw = (): void => {
        const width = cssWidth()
        const height = cssHeight()
        const context2d = canvas.getContext("2d")
        if (!isDefined(context2d)) {return}
        context2d.setTransform(dpr, 0, 0, dpr, 0, 0)
        context2d.clearRect(0, 0, width, height)
        const mid = height / 2
        const amp = height * 0.45

        // Waveform (min/max per pixel column).
        if (show.wave) {
            context2d.strokeStyle = COLOR_WAVE
            context2d.lineWidth = 1
            context2d.beginPath()
            for (let x = 0; x < width; x++) {
                const s0 = Math.max(0, Math.floor(xToSample(x)))
                const s1 = Math.min(frames, Math.max(s0 + 1, Math.floor(xToSample(x + 1))))
                let min = 1
                let max = -1
                for (let index = s0; index < s1; index++) {
                    const value = mono[index]
                    if (value < min) {min = value}
                    if (value > max) {max = value}
                }
                if (min > max) {min = max = 0}
                context2d.moveTo(x + 0.5, mid - max * amp)
                context2d.lineTo(x + 0.5, mid - min * amp)
            }
            context2d.stroke()
        }

        // Comparison markers loaded from a `.transients.json` (old-vs-new detector A/B).
        if (show.comparison && isDefined(comparison)) {
            context2d.strokeStyle = COLOR_COMPARISON
            context2d.globalAlpha = 0.5
            context2d.lineWidth = 1
            context2d.beginPath()
            for (let index = 0; index < comparison.length; index++) {
                const position = comparison[index]
                if (position < viewStart || position > viewStart + viewLength) {continue}
                const x = Math.round(sampleToX(position)) + 0.5
                context2d.moveTo(x, height * 0.62)
                context2d.lineTo(x, height)
            }
            context2d.stroke()
            context2d.globalAlpha = 1
        }

        // Detected / edited markers, weight + opacity by strength.
        if (show.detected) {
            for (let index = 0; index < markers.length; index++) {
                const marker = markers[index]
                if (marker.position < viewStart || marker.position > viewStart + viewLength) {continue}
                const x = sampleToX(marker.position)
                const norm = maxStrength > 0 ? marker.strength / maxStrength : 0
                const selected = index === selectedIndex
                const hovered = index === hoverIndex
                context2d.strokeStyle = selected ? COLOR_SELECTED : COLOR_DETECTED
                context2d.globalAlpha = selected || hovered ? 1 : 0.35 + 0.65 * norm
                context2d.lineWidth = (selected ? 2 : 1) + 2 * norm
                context2d.beginPath()
                context2d.moveTo(x + 0.5, 0)
                context2d.lineTo(x + 0.5, height * 0.6)
                context2d.stroke()
                // Strength wedge at the top.
                const size = 3 + 7 * norm
                context2d.fillStyle = selected ? COLOR_SELECTED : COLOR_DETECTED
                context2d.beginPath()
                context2d.moveTo(x + 0.5, 0)
                context2d.lineTo(x + 0.5 - size, 0)
                context2d.lineTo(x + 0.5, size * 1.6)
                context2d.closePath()
                context2d.fill()
            }
            context2d.globalAlpha = 1
        }

        // Playhead + active slice shading.
        if (isDefined(playing)) {
            const elapsed = (context.currentTime - playing.at) * sampleRate
            const head = playing.start + elapsed
            context2d.fillStyle = "rgba(255,255,255,0.06)"
            context2d.fillRect(sampleToX(playing.start), 0, sampleToX(playing.end) - sampleToX(playing.start), height)
            if (head <= playing.end) {
                const x = sampleToX(head)
                context2d.strokeStyle = COLOR_PLAYHEAD
                context2d.lineWidth = 1
                context2d.beginPath()
                context2d.moveTo(x + 0.5, 0)
                context2d.lineTo(x + 0.5, height)
                context2d.stroke()
            }
        }
        setStatus()
    }

    // Canvas sizing (device pixels).
    let dpr = 1
    const resize = (): void => {
        dpr = Math.max(1, window.devicePixelRatio || 1)
        canvas.width = Math.round(canvas.clientWidth * dpr)
        canvas.height = Math.round(canvas.clientHeight * dpr)
        invalidate()
    }
    const observer = new ResizeObserver(() => resize())
    observer.observe(canvas)

    // Interaction.
    let pointerDown = false
    let dragMode: "none" | "marker" | "pan" = "none"
    let dragIndex = -1
    let downX = 0
    let moved = false

    canvas.addEventListener("pointerdown", event => {
        canvas.focus()
        canvas.setPointerCapture(event.pointerId)
        pointerDown = true
        moved = false
        downX = event.offsetX
        const near = nearestMarker(event.offsetX)
        if (event.shiftKey) {
            dragMode = "pan"
        } else if (near >= 0) {
            dragMode = "marker"
            dragIndex = near
            selectedIndex = near
        } else {
            dragMode = "none"
            selectedIndex = -1
        }
        invalidate()
    })

    canvas.addEventListener("pointermove", event => {
        if (pointerDown) {
            if (Math.abs(event.offsetX - downX) > 2) {moved = true}
            if (dragMode === "pan") {
                const delta = (event.offsetX - downX) / cssWidth() * viewLength
                viewStart = clamp(viewStart - delta, 0, frames - viewLength)
                downX = event.offsetX
                invalidate()
            } else if (dragMode === "marker" && dragIndex >= 0) {
                markers[dragIndex].position = clamp(Math.round(xToSample(event.offsetX)), 0, frames)
                edited = true
                invalidate()
            }
        } else {
            const near = nearestMarker(event.offsetX)
            if (near !== hoverIndex) {hoverIndex = near; invalidate()}
        }
    })

    const endPointer = (event: PointerEvent): void => {
        if (!pointerDown) {return}
        pointerDown = false
        if (canvas.hasPointerCapture(event.pointerId)) {canvas.releasePointerCapture(event.pointerId)}
        if (!moved) {
            if (dragMode === "marker" && dragIndex >= 0) {
                const marker = markers[dragIndex]
                const next = dragIndex + 1 < markers.length ? markers[dragIndex + 1].position : frames
                play(marker.position, next)
            } else if (dragMode === "none") {
                const [start, end] = sliceAt(xToSample(event.offsetX))
                play(start, end)
            }
        } else if (dragMode === "marker" && dragIndex >= 0) {
            const dragged = markers[dragIndex]
            markers.sort((a, b) => a.position - b.position)
            selectedIndex = markers.indexOf(dragged)
        }
        dragMode = "none"
        dragIndex = -1
        invalidate()
    }
    canvas.addEventListener("pointerup", endPointer)
    canvas.addEventListener("pointercancel", endPointer)

    canvas.addEventListener("dblclick", event => {
        const position = clamp(Math.round(xToSample(event.offsetX)), 0, frames)
        markers.push({position, strength: maxStrength > 0 ? maxStrength * 0.5 : 0.5})
        markers.sort((a, b) => a.position - b.position)
        edited = true
        invalidate()
    })

    canvas.addEventListener("contextmenu", event => {
        event.preventDefault()
        const near = nearestMarker(event.offsetX)
        if (near >= 0) {
            markers.splice(near, 1)
            selectedIndex = -1
            edited = true
            invalidate()
        }
    })

    canvas.addEventListener("wheel", event => {
        event.preventDefault()
        if (event.shiftKey) {
            const delta = event.deltaY / cssWidth() * viewLength
            viewStart = clamp(viewStart + delta, 0, frames - viewLength)
        } else {
            const anchor = xToSample(event.offsetX)
            const factor = event.deltaY < 0 ? 0.8 : 1.25
            const newLength = clamp(Math.round(viewLength * factor), MIN_VIEW, frames)
            viewStart = clamp(Math.round(anchor - event.offsetX / cssWidth() * newLength), 0, frames - newLength)
            viewLength = newLength
        }
        invalidate()
    }, {passive: false})

    canvas.addEventListener("keydown", event => {
        if (event.key === " ") {
            event.preventDefault()
            if (isDefined(lastSlice)) {play(lastSlice[0], lastSlice[1])}
        } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && selectedIndex >= 0) {
            event.preventDefault()
            const step = (event.shiftKey ? 16 : 1) * (event.key === "ArrowLeft" ? -1 : 1)
            markers[selectedIndex].position = clamp(markers[selectedIndex].position + step, 0, frames)
            edited = true
            invalidate()
        } else if ((event.key === "Delete" || event.key === "Backspace") && selectedIndex >= 0) {
            event.preventDefault()
            markers.splice(selectedIndex, 1)
            selectedIndex = -1
            edited = true
            invalidate()
        }
    })

    // Render loop (only repaints when dirty or while playing).
    let raf = 0
    const frame = (): void => {
        raf = requestAnimationFrame(frame)
        if (dirty || isDefined(playing)) {
            dirty = false
            draw()
        }
    }
    resize()
    raf = requestAnimationFrame(frame)

    return {
        element,
        dispose: () => {
            cancelAnimationFrame(raf)
            observer.disconnect()
            stopPlayback()
        }
    }
}
