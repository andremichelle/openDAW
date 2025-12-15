import React, { useEffect, useState, useRef } from "react"
import { useApp } from "./AppContext"
import { SongData, TrackData, MarkerData } from "./types"
import { SimpleTrack, TrackHeader } from "./SimpleTrack"
import { SimpleAudioEngine } from "./SimpleAudioEngine"
import { AudioLoader } from "./AudioLoader"
import { MarkerItem } from "./MarkerItem"
import { v4 as uuidv4 } from 'uuid'
const { ipcRenderer } = window.require('electron')

export const WorkbenchView = () => {
    const { currentSongPath, settings } = useApp()
    const [song, setSong] = useState<SongData | null>(null)
    const [loading, setLoading] = useState(false)
    const [samplesPerPixel, setSamplesPerPixel] = useState(200)
    const [scrollX, setScrollX] = useState(0)

    // Playback State
    const [engine] = useState(() => new SimpleAudioEngine())
    const [isPlaying, setIsPlaying] = useState(false)
    const [playbackTime, setPlaybackTime] = useState(0)
    const [mutedTracks, setMutedTracks] = useState<Set<string>>(new Set())
    const [soloTracks, setSoloTracks] = useState<Set<string>>(new Set())

    // Markers & Padding
    const [markers, setMarkers] = useState<MarkerData[]>([])
    const [paddingMs, setPaddingMs] = useState(0)

    // Playback Loop
    useEffect(() => {
        let handle: number;
        const update = () => {
            if (isPlaying) {
                setPlaybackTime(engine.getCurrentTime());
                handle = requestAnimationFrame(update);
            }
        };
        if (isPlaying) update();
        return () => cancelAnimationFrame(handle);
    }, [isPlaying, engine]);

    useEffect(() => {
        if (!currentSongPath) return
        setLoading(true)
        engine.clear(); // Stop and clear previous song
        setIsPlaying(false);
        setPlaybackTime(0);

        ipcRenderer.invoke('load-song-details', currentSongPath)
            .then(async (data: SongData) => {
                setSong(data)
                setMarkers(data.guideMarkers || []) // Load existing if any (todo: persist)

                // Load Audio into Engine
                for (const track of data.tracks) {
                    try {
                        const { buffer } = await AudioLoader.loadAudio(track.filepath);
                        engine.addTrack(track.id, buffer);
                    } catch (e) {
                        console.error("Failed to load audio for playback", track.filename);
                    }
                }
            })
            .catch(console.error)
            .finally(() => setLoading(false))

        return () => { engine.clear() }
    }, [currentSongPath, engine])

    // Padding Calculation
    useEffect(() => {
        let minStart = 0;
        markers.forEach(m => {
            let start = m.timeMs;
            if (m.isEndAligned) start -= m.durationMs;
            minStart = Math.min(minStart, start);
        });
        setPaddingMs(Math.abs(minStart));
    }, [markers]);

    // Mixer Logic Update
    useEffect(() => {
        if (!song) return;
        const anySolo = soloTracks.size > 0;
        song.tracks.forEach(t => {
            let vol = 1.0;
            if (anySolo) {
                vol = soloTracks.has(t.id) ? 1.0 : 0.0;
            } else {
                vol = mutedTracks.has(t.id) ? 0.0 : 1.0;
            }
            engine.setTrackVolume(t.id, vol);
        });
    }, [mutedTracks, soloTracks, song, engine]);

    const togglePlayback = () => {
        if (isPlaying) {
            engine.pause();
            setIsPlaying(false);
        } else {
            engine.play();
            setIsPlaying(true);
        }
    }

    const addMarker = async (text: string) => {
        if (!song) return;

        const id = uuidv4();
        const timeMs = playbackTime * 1000;

        // Optimistic add
        const newMarker: MarkerData = {
            id, text, timeMs, durationMs: 1000,
            filepath: "", isEndAligned: timeMs === 0, isLoading: true
        };
        setMarkers(prev => [...prev, newMarker]);

        try {
            // 1. Determine Cache Path
            const isStandard = ["1", "2", "3", "4", "Verse", "Chorus", "Bridge", "Intro", "Outro"].includes(text);
            let cachePath: string;

            if (isStandard) {
                const globalCache = await ipcRenderer.invoke('get-global-cache-path');
                cachePath = `${globalCache}/${text}.mp3`;
            } else {
                const localCache = await ipcRenderer.invoke('get-song-local-cache-path', song.path);
                cachePath = `${localCache}/${text}.mp3`;
            }

            // 2. Generate if not exists
            // We assume main process checks file existence or we force generate?
            // The python code checks existence. We'll ask TTS to generate, backend should handle caching?
            // Actually our backend TTS just overwrites. We should ideally check in frontend or backend.
            // For simplicity, we just generate always or let backend handle it.
            // Let's assume we call generate.

            await ipcRenderer.invoke('tts:generate', { text, outputPath: cachePath });

            // 3. Load to get duration
            const { buffer } = await AudioLoader.loadAudio(cachePath);
            const durationMs = buffer.duration * 1000;

            setMarkers(prev => prev.map(m => m.id === id ? {
                ...m, isLoading: false, filepath: cachePath, durationMs
            } : m));

            // Also add to audio engine to preview? Python code does `preview_clip` via QMediaPlayer.
            // We can add a preview function later.

        } catch (e) {
            console.error("TTS Failed", e);
            setMarkers(prev => prev.filter(m => m.id !== id));
            alert("TTS Generation Failed");
        }
    };

    const deleteMarker = (id: string) => {
        setMarkers(prev => prev.filter(m => m.id !== id));
    };

    const toggleMarkerAlign = (id: string) => {
        setMarkers(prev => prev.map(m => m.id === id ? { ...m, isEndAligned: !m.isEndAligned } : m));
    };

    if (!currentSongPath) return <div style={{padding: 20}}>No song loaded.</div>
    if (loading) return <div style={{padding: 20}}>Loading song details...</div>
    if (!song) return <div style={{padding: 20}}>Failed to load song.</div>

    // Visual calculations with padding
    const timeToPixel = (ms: number) => {
        // Time 0 is at `paddingMs` pixels from left
        const totalMs = ms + paddingMs;
        const samples = (totalMs / 1000) * 44100;
        return samples / samplesPerPixel;
    };

    const toggleMute = (id: string) => {
        const next = new Set(mutedTracks)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setMutedTracks(next)
    }

    const toggleSolo = (id: string) => {
        const next = new Set(soloTracks)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        setSoloTracks(next)
    }

    // Zoom Logic
    const handleZoom = (e: React.ChangeEvent<HTMLInputElement>) => {
        // Slider 0-100
        const val = parseInt(e.target.value)
        // Log scale: 0 -> 10000, 100 -> 50
        // Invert val: 0 is zoomed out (high spp), 100 is zoomed in (low spp)
        // This matches the Python logic
        const minSpp = 50
        const maxSpp = 10000
        const normalized = val / 100.0

        // Python: log_spp = log_min + (1-norm) * (log_max - log_min)
        const logMin = Math.log(minSpp)
        const logMax = Math.log(maxSpp)
        const logSpp = logMin + (1.0 - normalized) * (logMax - logMin)
        const newSpp = Math.exp(logSpp)
        setSamplesPerPixel(newSpp)
    }

    // Slider value from SPP
    const sliderVal = (() => {
        const logMin = Math.log(50)
        const logMax = Math.log(10000)
        const logSpp = Math.log(samplesPerPixel)
        const normalized = 1.0 - (logSpp - logMin) / (logMax - logMin)
        return Math.round(normalized * 100)
    })()

    return (
        <div style={{display: "flex", flexDirection: "column", height: "100%"}}>
            {/* Toolbar */}
            <div style={{height: 50, background: "#333", display: "flex", alignItems: "center", padding: "0 10px", gap: 10}}>
                <div style={{fontWeight: "bold", marginRight: 20}}>{song.title}</div>

                <button
                    onClick={togglePlayback}
                    style={{
                        padding: "5px 20px", background: isPlaying ? "#cc3333" : "#33cc33",
                        border: "none", borderRadius: 4, color: "white", cursor: "pointer", fontWeight: "bold"
                    }}
                >
                    {isPlaying ? "Stop" : "Play"}
                </button>

                <div style={{fontFamily: "monospace", fontSize: 16, marginLeft: 10, width: 80}}>
                    {new Date(playbackTime * 1000).toISOString().substr(14, 8)}
                </div>

                {/* Markers */}
                <select onChange={(e) => {
                    if (e.target.value) {
                        addMarker(e.target.value);
                        e.target.value = "";
                    }
                }} style={{marginLeft: 20, padding: 5}}>
                    <option value="">Add Marker...</option>
                    {["1", "2", "3", "4", "Verse", "Chorus", "Bridge", "Intro", "Outro"].map(s => (
                        <option key={s} value={s}>{s}</option>
                    ))}
                </select>
                <button onClick={() => {
                    const txt = prompt("Marker Text:");
                    if (txt) addMarker(txt);
                }}>+ Custom</button>

                <div style={{flex: 1}}/>

                <div style={{color: "#ff6666", fontWeight: "bold", marginRight: 10}}>
                    Padding: {Math.round(paddingMs)} ms
                </div>

                <div>Zoom:</div>
                <input
                    type="range" min="0" max="100"
                    value={sliderVal}
                    onChange={handleZoom}
                    style={{width: 150}}
                />
            </div>

            {/* Main Area */}
            <div style={{flex: 1, display: "flex", overflow: "hidden"}}>
                {/* Track Headers (Left) */}
                <div style={{width: 250, background: "#252526", borderRight: "1px solid #000", overflow: "hidden"}}>
                    <div style={{height: 30, borderBottom: "1px solid #444", background: "#333"}}></div> {/* Ruler Placeholder */}
                    {song.tracks.map(t => (
                        <TrackHeader
                            key={t.id}
                            track={t}
                            height={80}
                            isMuted={mutedTracks.has(t.id)}
                            isSolo={soloTracks.has(t.id)}
                            onMute={() => toggleMute(t.id)}
                            onSolo={() => toggleSolo(t.id)}
                        />
                    ))}
                </div>

                {/* Timeline (Right) */}
                <div
                    style={{flex: 1, overflowX: "scroll", overflowY: "hidden", position: "relative", background: "#1e1e1e"}}
                    onScroll={(e) => setScrollX(e.currentTarget.scrollLeft)}
                >
                    <div style={{minWidth: "100%", height: "100%"}}> {/* Container to allow scrolling */}

                        {/* Ruler */}
                        <div style={{height: 30, background: "#222", borderBottom: "1px solid #444", position: "sticky", top: 0, zIndex: 20}}>
                            {/* Zero Line */}
                            <div style={{
                                position: "absolute", left: timeToPixel(0), top: 0, height: 1000, width: 1, background: "#555"
                            }}/>

                            {/* Markers Overlay in Ruler */}
                            {markers.map(m => (
                                <div key={m.id} style={{position: "absolute", left: timeToPixel(m.timeMs - (m.isEndAligned ? m.durationMs : 0)), top: 0}}>
                                    <MarkerItem
                                        marker={m}
                                        height={1000}
                                        samplesPerPixel={samplesPerPixel}
                                        sampleRate={44100}
                                        onDelete={() => deleteMarker(m.id)}
                                        onToggleAlign={() => toggleMarkerAlign(m.id)}
                                    />
                                </div>
                            ))}

                            {/* Playhead */}
                            <div style={{
                                position: "absolute",
                                left: timeToPixel(playbackTime * 1000),
                                top: 0,
                                height: 1000,
                                width: 1,
                                background: "yellow",
                                zIndex: 101,
                                pointerEvents: "none"
                            }}/>
                        </div>

                        {/* Tracks */}
                        {song.tracks.map(t => (
                            <div key={t.id} style={{position: "relative"}}>
                                {/* Wrapper to apply Padding Offset (time 0) */}
                                <div style={{
                                    position: "absolute",
                                    left: timeToPixel(0),
                                    width: "100%", // This might need to be larger or just use overflow visible
                                    height: 80,
                                    pointerEvents: "none" // Allow clicking through if needed
                                }}>
                                    {/* SimpleTrack renders at 'initialOffsetMs' relative to this container */}
                                    <div style={{pointerEvents: "auto"}}>
                                        <SimpleTrack
                                            track={t}
                                            samplesPerPixel={samplesPerPixel}
                                            height={80}
                                            scrollX={scrollX}
                                        />
                                    </div>
                                </div>
                                {/* Spacer to ensure row height in the relative container */}
                                <div style={{height: 80}}></div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
