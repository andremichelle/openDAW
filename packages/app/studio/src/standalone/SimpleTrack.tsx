import React, { useEffect, useRef, useState } from "react"
import { CanvasPainter } from "@/ui/canvas/painter"
import { createSimpleAudioPainter } from "./SimpleAudioPainter"
import { AudioLoader } from "./AudioLoader"
import { Peaks } from "@opendaw/lib-fusion"
import { TrackData, TrackRole } from "./types"
import { Lifecycle } from "@opendaw/lib-std"

interface Props {
    track: TrackData;
    samplesPerPixel: number;
    height: number;
    scrollX: number; // In pixels
}

export const SimpleTrack = ({ track, samplesPerPixel, height, scrollX }: Props) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [peaks, setPeaks] = useState<Peaks | null>(null)
    const [duration, setDuration] = useState(0)
    const [error, setError] = useState(false)
    const lifecycleRef = useRef<Lifecycle>(new Lifecycle())
    const painterRef = useRef<CanvasPainter | null>(null)

    useEffect(() => {
        let active = true
        setError(false)

        AudioLoader.loadAudio(track.filepath)
            .then(({ buffer, peaks }) => {
                if (active) {
                    setPeaks(peaks)
                    setDuration(buffer.duration)
                }
            })
            .catch(e => {
                console.error("Failed to load audio for track", track.filename, e)
                if (active) setError(true)
            })

        return () => { active = false }
    }, [track.filepath])

    useEffect(() => {
        if (!canvasRef.current || !peaks) return

        const painter = new CanvasPainter(canvasRef.current, createSimpleAudioPainter({
            peaks,
            durationSeconds: duration,
            gain: 0,
            hue: getHueForRole(track.role)
        }))
        painterRef.current = painter

        lifecycleRef.current.own(painter)

        return () => {
            lifecycleRef.current.clear()
            painterRef.current = null
        }
    }, [peaks, duration, track.role])

    // Update painter on scroll/zoom if needed (though canvas size change triggers update)
    useEffect(() => {
        painterRef.current?.requestUpdate()
    }, [samplesPerPixel])

    // We render the FULL width canvas for now (simple), inside a scrolling container in parent.
    // Or we optimize?
    // Optimization: The parent (Workbench) has a scrollable div. We just place the track content inside it.

    // Width calculation
    const width = peaks ? (peaks.unwrap().numFrames / samplesPerPixel) : 0
    const offsetPixels = (track.initialOffsetMs / 1000 * 44100) / samplesPerPixel

    return (
        <div style={{
            height,
            display: "flex",
            background: "#252526",
            marginBottom: 2,
            alignItems: "center",
            position: "relative"
        }}>
            {/* Header - Fixed Position using sticky if possible, or just absolute in parent */}
            {/* Wait, the header should stay visible while scrolling horizontally.
                The common way is a flex layout where the headers are in a separate column
                and the tracks are in a scrollable area.
                Let's assume the parent handles the layout split.
                This component will just render the LANE (waveform).
            */}

            <div style={{
                position: "absolute",
                left: offsetPixels,
                top: 0,
                width: width,
                height: "100%"
            }}>
                {peaks && (
                    <canvas
                        ref={canvasRef}
                        style={{width: "100%", height: "100%"}}
                    />
                )}
            </div>

             {error && <div style={{color: "red", padding: 10}}>Load Failed</div>}
             {!peaks && !error && <div style={{color: "#888", padding: 10}}>Loading...</div>}
        </div>
    )
}

export const TrackHeader = ({ track, height, onMute, onSolo, isMuted, isSolo }: {
    track: TrackData, height: number,
    onMute: () => void, onSolo: () => void,
    isMuted: boolean, isSolo: boolean
}) => {
    return (
        <div style={{
            height,
            borderBottom: "2px solid #1e1e1e",
            display: "flex",
            alignItems: "center",
            padding: "0 10px",
            background: "#2d2d30",
            color: "#ccc",
            fontSize: 12,
            boxSizing: "border-box"
        }}>
            <div style={{flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 10}}>
                {track.filename}
            </div>
            <button
                onClick={onMute}
                style={{
                    background: isMuted ? "#cc3333" : "#444",
                    border: "none", color: "white", width: 24, height: 24, marginRight: 4, cursor: "pointer"
                }}
            >M</button>
            <button
                onClick={onSolo}
                style={{
                    background: isSolo ? "#cccc33" : "#444",
                    border: "none", color: "white", width: 24, height: 24, cursor: "pointer"
                }}
            >S</button>
        </div>
    )
}

function getHueForRole(role: string): number {
    switch (role) {
        case TrackRole.DRUMS: return 0; // Red
        case TrackRole.BASS: return 240; // Blue
        case TrackRole.GUITAR: return 120; // Green
        case TrackRole.VOCALS: return 60; // Yellow
        case TrackRole.CLICK_GUIDE: return 300; // Magenta
        default: return 180; // Cyan
    }
}
