import {createElement} from "@opendaw/lib-jsx"
import {CanvasPainter} from "@/ui/canvas/painter"
import {createSimpleAudioPainter} from "./SimpleAudioPainter"
import {AudioLoader} from "./AudioLoader"
import {Peaks} from "@opendaw/lib-fusion"
import {TrackData, TrackRole} from "./types"
import {Lifecycle, Terminator} from "@opendaw/lib-std"
import {DefaultObservableValue} from "@opendaw/lib-std"

interface Props {
    track: TrackData;
    samplesPerPixel: DefaultObservableValue<number>;
    height: number;
}

export const SimpleTrack = (lifecycle: Lifecycle, { track, samplesPerPixel, height }: Props) => {
    const canvas = <canvas style={{width: "100%", height: "100%"}} /> as HTMLCanvasElement
    const errorMsg = <div style={{color: "red", padding: "10px", display: "none"}}>Load Failed</div>
    const loadingMsg = <div style={{color: "#888", padding: "10px"}}>Loading...</div>

    const wrapper = (
        <div style={{
            height: `${height}px`,
            display: "flex",
            background: "#252526",
            marginBottom: "2px",
            alignItems: "center",
            position: "relative"
        }}>
            <div style={{
                position: "absolute",
                left: "0px",
                top: "0px",
                width: "0px", // Updated dynamically
                height: "100%"
            }}>
                {canvas}
            </div>
            {errorMsg}
            {loadingMsg}
        </div>
    )

    let peaks: Peaks | null = null
    let duration = 0
    let currentPainter: Terminator | null = null

    const updateLayout = () => {
        const spp = samplesPerPixel.getValue()
        const div = canvas.parentElement
        if (!div) return

        if (peaks) {
             const width = peaks.numFrames / spp
             div.style.width = `${width}px`
             div.style.left = `${(track.initialOffsetMs / 1000 * 44100) / spp}px` // LOCAL offset
        }
    }

    const initPainter = () => {
        if (currentPainter) currentPainter.terminate()
        if (!peaks) return

        const painter = new CanvasPainter(canvas, createSimpleAudioPainter({
            peaks,
            durationSeconds: duration,
            gain: 0,
            hue: getHueForRole(track.role)
        }))

        // Listen to zoom
        const sub = samplesPerPixel.subscribe(() => {
            updateLayout()
            painter.requestUpdate()
        })

        const term = new Terminator()
        term.own(painter)
        term.own(sub)

        lifecycle.own(term)
        currentPainter = term

        updateLayout()
    }

    AudioLoader.loadAudio(track.filepath)
        .then(({ buffer, peaks: p }) => {
            peaks = p
            duration = buffer.duration
            loadingMsg.style.display = "none"
            initPainter()
        })
        .catch(e => {
            console.error("Failed to load audio", track.filename, e)
            loadingMsg.style.display = "none"
            errorMsg.style.display = "block"
        })

    return wrapper
}

export const TrackHeader = ({ track, height, onMute, onSolo, isMuted, isSolo }: {
    track: TrackData, height: number,
    onMute: () => void, onSolo: () => void,
    isMuted: boolean, isSolo: boolean
}) => {
    const btnStyle = (active: boolean, color: string) => ({
        background: active ? color : "#444",
        border: "none", color: "white", width: "24px", height: "24px",
        marginRight: "4px", cursor: "pointer"
    })

    const muteBtn = <button style={btnStyle(isMuted, "#cc3333")}>M</button>
    muteBtn.onclick = onMute

    const soloBtn = <button style={btnStyle(isSolo, "#cccc33")}>S</button>
    soloBtn.onclick = onSolo

    return (
        <div style={{
            height: `${height}px`,
            borderBottom: "2px solid #1e1e1e",
            display: "flex",
            alignItems: "center",
            padding: "0 10px",
            background: "#2d2d30",
            color: "#ccc",
            fontSize: "12px",
            boxSizing: "border-box"
        }}>
            <div style={{flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: "10px"}}>
                {track.filename}
            </div>
            {muteBtn}
            {soloBtn}
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
