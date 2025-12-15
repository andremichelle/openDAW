import {createElement} from "@opendaw/lib-jsx"
import {Lifecycle, DefaultObservableValue} from "@opendaw/lib-std"
import {appState} from "./AppState"
import {SongData, MarkerData} from "./types"
import {SimpleTrack, TrackHeader} from "./SimpleTrack"
import {SimpleAudioEngine} from "./SimpleAudioEngine"
import {AudioLoader} from "./AudioLoader"
import {MarkerItem} from "./MarkerItem"
import {v4 as uuidv4} from 'uuid'
import {Html} from "@opendaw/lib-dom"

const { ipcRenderer } = window.require('electron')

export const WorkbenchView = (parentLifecycle: Lifecycle) => {
    // Lifecycle for this view instance
    const lifecycle = parentLifecycle // reusing parent for now

    const container = <div style={{display: "flex", flexDirection: "column", height: "100%"}}/>
    const toolbar = <div style={{height: "50px", background: "#333", display: "flex", alignItems: "center", padding: "0 10px", gap: "10px"}}/>
    const mainArea = <div style={{flex: "1", display: "flex", overflow: "hidden"}}/>
    const trackHeaders = <div style={{width: "250px", background: "#252526", borderRight: "1px solid #000", overflow: "hidden"}}/>
    const timelineArea = <div style={{flex: "1", overflowX: "scroll", overflowY: "hidden", position: "relative", background: "#1e1e1e"}}/>
    const tracksContainer = <div style={{minWidth: "100%", height: "100%"}}/>
    const ruler = <div style={{height: "30px", background: "#222", borderBottom: "1px solid #444", position: "sticky", top: "0", zIndex: "20"}}/>

    container.appendChild(toolbar)
    container.appendChild(mainArea)
    mainArea.appendChild(trackHeaders)
    mainArea.appendChild(timelineArea)
    timelineArea.appendChild(tracksContainer)
    tracksContainer.appendChild(ruler) // Ruler is inside scrollable area but sticky

    // State
    const samplesPerPixel = new DefaultObservableValue(200)
    const engine = new SimpleAudioEngine()
    let isPlaying = false
    let playbackTime = 0
    let songData: SongData | null = null
    let markers: MarkerData[] = []
    let paddingMs = 0

    // Playback loop
    const timeDisplay = <div style={{fontFamily: "monospace", fontSize: "16px", marginLeft: "10px", width: "80px"}}>00:00.00</div>
    const playhead = <div style={{position: "absolute", top: "0", height: "1000px", width: "1px", background: "yellow", zIndex: "101", pointerEvents: "none", left: "0px"}}/>
    ruler.appendChild(playhead)

    const updatePlayhead = () => {
        const timeToPixel = (ms: number) => {
            const totalMs = ms + paddingMs
            const samples = (totalMs / 1000) * 44100
            return samples / samplesPerPixel.getValue()
        }

        const px = timeToPixel(playbackTime * 1000)
        playhead.style.left = `${px}px`

        const date = new Date(playbackTime * 1000)
        timeDisplay.textContent = date.toISOString().substr(14, 8)
    }

    const loop = () => {
        if (isPlaying) {
            playbackTime = engine.getCurrentTime()
            updatePlayhead()
            requestAnimationFrame(loop)
        }
    }

    // Zoom Listener to update playhead immediately
    lifecycle.own(samplesPerPixel.subscribe(updatePlayhead))

    // Controls
    const playBtn = <button style={{padding: "5px 20px", background: "#33cc33", border: "none", borderRadius: "4px", color: "white", cursor: "pointer", fontWeight: "bold"}}>Play</button>
    playBtn.onclick = () => {
        if (isPlaying) {
            engine.pause()
            isPlaying = false
            playBtn.textContent = "Play"
            playBtn.style.background = "#33cc33"
        } else {
            engine.play()
            isPlaying = true
            playBtn.textContent = "Stop"
            playBtn.style.background = "#cc3333"
            loop()
        }
    }

    const zoomSlider = <input type="range" min="0" max="100" style={{width: "150px"}}/>
    zoomSlider.oninput = (e: any) => {
        const val = parseInt(e.target.value)
        const minSpp = 50, maxSpp = 10000
        const normalized = val / 100.0
        const logMin = Math.log(minSpp), logMax = Math.log(maxSpp)
        const logSpp = logMin + (1.0 - normalized) * (logMax - logMin)
        samplesPerPixel.setValue(Math.exp(logSpp))
        updatePlayhead()
        renderMarkers() // Re-render markers on zoom
        // Tracks listen to spp automatically
        renderTracks() // Re-render track wrappers (left position depends on spp)
    }
    // Set initial slider
    {
        const logMin = Math.log(50), logMax = Math.log(10000)
        const logSpp = Math.log(200)
        const norm = 1.0 - (logSpp - logMin) / (logMax - logMin)
        zoomSlider.value = String(Math.round(norm * 100))
    }

    toolbar.appendChild(<div style={{fontWeight: "bold", marginRight: "20px"}} id="song-title">No Song</div>)
    toolbar.appendChild(playBtn)
    toolbar.appendChild(timeDisplay)

    // Marker Controls
    const addMarker = async (text: string) => {
        if (!songData) return
        const id = uuidv4()
        const timeMs = playbackTime * 1000
        const newMarker: MarkerData = {
            id, text, timeMs, durationMs: 1000,
            filepath: "", isEndAligned: timeMs === 0, isLoading: true
        }
        markers.push(newMarker)
        renderMarkers()
        updatePadding()

        try {
            const isStandard = ["1", "2", "3", "4", "Verse", "Chorus", "Bridge", "Intro", "Outro"].includes(text)
            let cachePath: string
            if (isStandard) {
                const globalCache = await ipcRenderer.invoke('get-global-cache-path')
                cachePath = `${globalCache}/${text}.mp3`
            } else {
                const localCache = await ipcRenderer.invoke('get-song-local-cache-path', songData.path)
                cachePath = `${localCache}/${text}.mp3`
            }

            await ipcRenderer.invoke('tts:generate', { text, outputPath: cachePath })

            const { buffer } = await AudioLoader.loadAudio(cachePath)
            const durationMs = buffer.duration * 1000

            const m = markers.find(x => x.id === id)
            if (m) {
                m.isLoading = false
                m.filepath = cachePath
                m.durationMs = durationMs
                renderMarkers()
                updatePadding() // Duration change might affect padding
            }
        } catch (e) {
            console.error(e)
            markers = markers.filter(x => x.id !== id)
            renderMarkers()
            alert("TTS Failed")
        }
    }

    const markerSelect = <select style={{marginLeft: "20px", padding: "5px"}}>
        <option value="">Add Marker...</option>
        {["1", "2", "3", "4", "Verse", "Chorus", "Bridge", "Intro", "Outro"].map(s => <option value={s}>{s}</option>)}
    </select>
    markerSelect.onchange = (e: any) => {
        if (e.target.value) {
            addMarker(e.target.value)
            e.target.value = ""
        }
    }

    const markerCustomBtn = <button onclick={() => {
        const txt = prompt("Marker Text:")
        if (txt) addMarker(txt)
    }}>+ Custom</button>

    toolbar.appendChild(markerSelect)
    toolbar.appendChild(markerCustomBtn)
    toolbar.appendChild(<div style={{flex: "1"}}/>)
    const paddingLabel = <div style={{color: "#ff6666", fontWeight: "bold", marginRight: "10px"}}>Padding: 0 ms</div>
    toolbar.appendChild(paddingLabel)
    toolbar.appendChild(<div>Zoom:</div>)
    toolbar.appendChild(zoomSlider)

    // Rendering Logic
    const markersLayer = <div style={{position: "absolute", top: "0", left: "0", width: "100%", height: "1000px", pointerEvents: "none"}}/>
    ruler.appendChild(markersLayer)
    // Zero line
    const zeroLine = <div style={{position: "absolute", top: "0", height: "1000px", width: "1px", background: "#555"}}/>
    ruler.appendChild(zeroLine)

    const updatePadding = () => {
        let minStart = 0
        markers.forEach(m => {
            let start = m.timeMs
            if (m.isEndAligned) start -= m.durationMs
            minStart = Math.min(minStart, start)
        })
        paddingMs = Math.abs(minStart)
        paddingLabel.textContent = `Padding: ${Math.round(paddingMs)} ms`

        // Re-render everything affected by padding
        const timeToPixel = (ms: number) => ((ms + paddingMs) / 1000 * 44100) / samplesPerPixel.getValue()
        zeroLine.style.left = `${timeToPixel(0)}px`
        renderMarkers()
        renderTracks()
        updatePlayhead()
    }

    const renderMarkers = () => {
        Html.empty(markersLayer)
        const timeToPixel = (ms: number) => ((ms + paddingMs) / 1000 * 44100) / samplesPerPixel.getValue()

        markers.forEach(m => {
            const start = m.timeMs - (m.isEndAligned ? m.durationMs : 0)
            const left = timeToPixel(start)

            // Wrap in absolute div
            const wrapper = <div style={{position: "absolute", left: `${left}px`, top: "0px", pointerEvents: "auto"}}/>
            const item = MarkerItem({
                marker: m,
                height: 1000,
                onDelete: () => {
                    markers = markers.filter(x => x.id !== m.id)
                    renderMarkers()
                    updatePadding()
                },
                onToggleAlign: () => {
                    m.isEndAligned = !m.isEndAligned
                    renderMarkers()
                    updatePadding()
                }
            })
            wrapper.appendChild(item)
            markersLayer.appendChild(wrapper)
        })
    }

    // Track List Rendering
    const tracksLayer = <div/>
    tracksContainer.appendChild(tracksLayer)

    // Mute/Solo State
    const muted = new Set<string>()
    const solo = new Set<string>()

    const updateMixer = () => {
        if (!songData) return
        const anySolo = solo.size > 0
        songData.tracks.forEach(t => {
            let vol = 1.0
            if (anySolo) {
                vol = solo.has(t.id) ? 1.0 : 0.0
            } else {
                vol = muted.has(t.id) ? 0.0 : 1.0
            }
            engine.setTrackVolume(t.id, vol)
        })
        renderHeaders()
    }

    const renderHeaders = () => {
        if (!songData) return
        Html.empty(trackHeaders)
        // Ruler Spacer
        trackHeaders.appendChild(<div style={{height: "30px", borderBottom: "1px solid #444", background: "#333"}}/>)

        songData.tracks.forEach(t => {
            const header = TrackHeader({
                track: t, height: 80,
                isMuted: muted.has(t.id),
                isSolo: solo.has(t.id),
                onMute: () => {
                    if (muted.has(t.id)) muted.delete(t.id); else muted.add(t.id)
                    updateMixer()
                },
                onSolo: () => {
                    if (solo.has(t.id)) solo.delete(t.id); else solo.add(t.id)
                    updateMixer()
                }
            })
            trackHeaders.appendChild(header)
        })
    }

    const renderTracks = () => {
        if (!songData) return
        Html.empty(tracksLayer)
        const timeToPixel = (ms: number) => ((ms + paddingMs) / 1000 * 44100) / samplesPerPixel.getValue()
        const startPx = timeToPixel(0)

        songData.tracks.forEach(t => {
            const row = <div style={{position: "relative", height: "80px"}}/>

            // Wrapper for padding offset
            const offsetWrapper = <div style={{
                position: "absolute",
                left: `${startPx}px`,
                width: "100%",
                height: "80px",
                pointerEvents: "none"
            }}/>

            const trackEl = SimpleTrack(lifecycle, {
                track: t,
                samplesPerPixel,
                height: 80
            })
            trackEl.style.pointerEvents = "auto"

            offsetWrapper.appendChild(trackEl)
            row.appendChild(offsetWrapper)
            tracksLayer.appendChild(row)
        })
    }

    // Load Song
    const loadSong = async (path: string) => {
        container.querySelector("#song-title")!.textContent = "Loading..."
        engine.clear()
        isPlaying = false
        playbackTime = 0
        markers = []
        muted.clear()
        solo.clear()

        try {
            songData = await ipcRenderer.invoke('load-song-details', path)
            if (!songData) throw new Error("No data")

            container.querySelector("#song-title")!.textContent = songData.title
            markers = songData.guideMarkers || []
            updatePadding() // will trigger renderMarkers and renderTracks(empty)

            renderHeaders()
            renderTracks() // Now with tracks

            // Load Audio
            for (const t of songData.tracks) {
                try {
                    const {buffer} = await AudioLoader.loadAudio(t.filepath)
                    engine.addTrack(t.id, buffer)
                } catch(e) {
                    console.error("Audio load failed", t.filename)
                }
            }
        } catch (e) {
            console.error(e)
            container.querySelector("#song-title")!.textContent = "Error Loading Song"
        }
    }

    // Subscribe to global song path
    lifecycle.own(appState.currentSongPath.subscribe(owner => {
        const path = owner.getValue()
        if (path) loadSong(path)
    }))

    return container
}
