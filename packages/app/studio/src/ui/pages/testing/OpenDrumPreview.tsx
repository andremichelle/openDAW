import css from "./OpenDrumPreview.sass?inline"
import referenceCss from "./OpenDrumReference.sass?inline"
import {Color, DefaultObservableValue, Lifecycle, Notifier, Option, Provider} from "@opendaw/lib-std"
import {createElement, Group} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {CanvasPainter} from "@opendaw/studio-core"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {OpenDrumControls} from "@/ui/pages/testing/opendrum/OpenDrumControls"
import {OpenDrumSynth} from "@/ui/pages/testing/opendrum/OpenDrumSynth"
import {PreviewDevicePanel} from "@/ui/pages/testing/preview/PreviewDevicePanel"
import {Checkbox} from "@/ui/components/Checkbox"

const className = Html.adoptStyleSheet(css, "OpenDrumPreview")
const referenceClassName = Html.adoptStyleSheet(referenceCss, "OpenDrumReference")

type Construct = {
    lifecycle: Lifecycle
    audioContext: AudioContext
}

type Device = {
    readonly name: string
    readonly color: Color
    readonly render: Provider<Option<OpenDrumSynth.Hit>>
    readonly groups: ReadonlyArray<HTMLElement>
    readonly refresh: Notifier<void>
    readonly reference: string
    readonly poly: Provider<boolean>
}

const PreviewBpm = 120
// both the hit and the reference pass two high-pass filters: open at 10 Hz, at 1 kHz only the noise is left
const OpenFilterHz = 10
const NoiseOnlyHz = 1000

export const OpenDrumPreview = ({lifecycle, audioContext}: Construct) => {
    const {Formats, group} = OpenDrumControls
    const {PlayModes, RumbleLengths} = OpenDrumSynth
    const kickDevice = (name: string, kick: OpenDrumSynth.Kick, reference: string): Device => {
        const refresh = lifecycle.own(new Notifier<void>())
        const field = (name: string, min: number, max: number, step: number, format: OpenDrumControls.Format,
                       key: keyof OpenDrumSynth.Kick): OpenDrumControls.Field =>
            ({name, get: () => kick[key], set: value => kick[key] = value, range: {min, max, step, format}})
        const choice = (name: string, choices: ReadonlyArray<string>, key: keyof OpenDrumSynth.Kick): OpenDrumControls.Field =>
            ({name, get: () => kick[key], set: value => kick[key] = value, choices})
        const groups: ReadonlyArray<HTMLElement> = [
            group(lifecycle, refresh, "orange", "Body", 2, [
                field("Tune", 30, 120, 0.5, Formats.fixed(1, "Hz"), "tune"),
                field("Pitch", 0, 48, 0.5, Formats.fixed(1, "st"), "pitch"),
                field("Sweep", 0.001, 0.2, 0.001, Formats.seconds, "sweep"),
                field("Drift", 0, 12, 0.1, Formats.fixed(1, "st"), "drift"),
                field("Decay", 0.02, 6, 0.01, Formats.seconds, "decay"),
                field("Punch", -1, 1, 0.01, Formats.percent, "punch"),
                field("Shape", 0, 1, 0.01, Formats.percent, "shape"),
                field("Skin", 0, 1, 0.01, Formats.percent, "skin")
            ]),
            group(lifecycle, refresh, "yellow", "Strike", 1, [
                field("Click", 0, 1, 0.01, Formats.percent, "click"),
                field("Tone", 200, 16000, 100, Formats.hertz, "tone"),
                field("Noise", 0, 1, 0.01, Formats.percent, "noise"),
                field("Drive", 0, 36, 0.5, Formats.decibel, "drive")
            ]),
            group(lifecycle, refresh, "purple", "Rumble", 1, [
                field("Level", 0, 1, 0.01, Formats.percent, "rumble"),
                choice("Length", RumbleLengths, "length"),
                field("Duck", 0, 1, 0.01, Formats.percent, "duck"),
                field("Bright", 0, 1, 0.01, Formats.percent, "bright")
            ]),
            group(lifecycle, refresh, "cream", "Play", 1, [
                field("Volume", -36, 6, 0.5, Formats.decibel, "volume"),
                field("Velocity", 0, 1, 0.01, Formats.percent, "velocity"),
                choice("Mode", PlayModes, "play"),
                field("Glide", 0, 1, 0.005, Formats.seconds, "glide")
            ])
        ]
        return {name, color: Colors.orange, groups, refresh, reference, poly: () => kick.play === 1,
            render: () => renderer.map(loaded => loaded.renderKick(kick, PreviewBpm))}
    }
    const snareDevice = (name: string, snare: OpenDrumSynth.Snare, reference: string): Device => {
        const refresh = lifecycle.own(new Notifier<void>())
        const field = (name: string, min: number, max: number, step: number, format: OpenDrumControls.Format,
                       key: keyof OpenDrumSynth.Snare): OpenDrumControls.Field =>
            ({name, get: () => snare[key], set: value => snare[key] = value, range: {min, max, step, format}})
        const choice = (name: string, choices: ReadonlyArray<string>, key: keyof OpenDrumSynth.Snare): OpenDrumControls.Field =>
            ({name, get: () => snare[key], set: value => snare[key] = value, choices})
        const groups: ReadonlyArray<HTMLElement> = [
            group(lifecycle, refresh, "orange", "Body", 2, [
                field("Tune", 80, 600, 0.5, Formats.fixed(1, "Hz"), "tune"),
                field("Ratio", 1, 3, 0.01, Formats.fixed(2, ""), "ratio"),
                field("Balance", 0, 1, 0.01, Formats.percent, "balance"),
                field("Pitch", 0, 24, 0.5, Formats.fixed(1, "st"), "pitch"),
                field("Sweep", 0.001, 0.1, 0.001, Formats.seconds, "sweep"),
                field("Decay", 0.02, 2, 0.01, Formats.seconds, "decay"),
                field("Punch", -1, 1, 0.01, Formats.percent, "punch"),
                field("Shape", 0, 1, 0.01, Formats.percent, "shape")
            ]),
            group(lifecycle, refresh, "yellow", "Strike", 1, [
                field("Click", 0, 1, 0.01, Formats.percent, "click"),
                field("Tone", 200, 16000, 100, Formats.hertz, "tone"),
                field("Skin", 0, 1, 0.01, Formats.percent, "skin"),
                field("Drive", 0, 36, 0.5, Formats.decibel, "drive")
            ]),
            group(lifecycle, refresh, "green", "Noise", 1, [
                field("Level", -48, -3, 0.5, Formats.decibel, "level"),
                field("Decay", 0.02, 2, 0.01, Formats.seconds, "wireDecay"),
                field("Width", 0, 1, 0.01, Formats.percent, "width"),
                field("Curve", -1, 1, 0.01, Formats.percent, "curve")
            ]),
            group(lifecycle, refresh, "cream", "Play", 1, [
                field("Volume", -36, 6, 0.5, Formats.decibel, "volume"),
                field("Velocity", 0, 1, 0.01, Formats.percent, "velocity"),
                choice("Mode", PlayModes, "play"),
                field("Glide", 0, 1, 0.005, Formats.seconds, "glide")
            ])
        ]
        return {name, color: Colors.green, groups, refresh, reference, poly: () => snare.play === 1,
            render: () => renderer.map(loaded => loaded.renderSnare(snare))}
    }
    const tomDevice = (name: string, tom: OpenDrumSynth.Tom, reference: string): Device => {
        const refresh = lifecycle.own(new Notifier<void>())
        const field = (name: string, min: number, max: number, step: number, format: OpenDrumControls.Format,
                       key: keyof OpenDrumSynth.Tom): OpenDrumControls.Field =>
            ({name, get: () => tom[key], set: value => tom[key] = value, range: {min, max, step, format}})
        const choice = (name: string, choices: ReadonlyArray<string>, key: keyof OpenDrumSynth.Tom): OpenDrumControls.Field =>
            ({name, get: () => tom[key], set: value => tom[key] = value, choices})
        const groups: ReadonlyArray<HTMLElement> = [
            group(lifecycle, refresh, "orange", "Body", 2, [
                field("Tune", 40, 800, 0.5, Formats.fixed(1, "Hz"), "tune"),
                field("Pitch", 0, 24, 0.1, Formats.fixed(1, "st"), "pitch"),
                field("Sweep", 0.001, 0.2, 0.001, Formats.seconds, "sweep"),
                field("Drift", 0, 12, 0.1, Formats.fixed(1, "st"), "drift"),
                field("Decay", 0.02, 3, 0.01, Formats.seconds, "decay"),
                field("Punch", -1, 1, 0.01, Formats.percent, "punch"),
                field("Shape", 0, 1, 0.01, Formats.percent, "shape"),
                field("Drive", 0, 36, 0.5, Formats.decibel, "drive")
            ]),
            group(lifecycle, refresh, "yellow", "Layers", 1, [
                field("Sub", 0, 1, 0.01, Formats.percent, "sub"),
                field("Ratio", 0.5, 1, 0.01, Formats.fixed(2, ""), "ratio"),
                field("Top", 0, 1, 0.01, Formats.percent, "top"),
                field("Length", 0.02, 1, 0.01, Formats.seconds, "length")
            ]),
            group(lifecycle, refresh, "green", "Noise", 1, [
                field("Level", -48, 0, 0.5, Formats.decibel, "noise"),
                field("Decay", 0.02, 3, 0.01, Formats.seconds, "noiseDecay"),
                field("Color", 0, 1, 0.01, Formats.percent, "color"),
                field("Air", 0, 1, 0.01, Formats.percent, "air")
            ]),
            group(lifecycle, refresh, "cream", "Play", 1, [
                field("Volume", -36, 6, 0.5, Formats.decibel, "volume"),
                field("Velocity", 0, 1, 0.01, Formats.percent, "velocity"),
                choice("Mode", PlayModes, "play"),
                field("Glide", 0, 1, 0.005, Formats.seconds, "glide")
            ])
        ]
        return {name, color: Colors.blue, groups, refresh, reference, poly: () => tom.play === 1,
            render: () => renderer.map(loaded => loaded.renderTom(tom))}
    }
    const clapDevice = (name: string, clap: OpenDrumSynth.Clap, reference: string): Device => {
        const refresh = lifecycle.own(new Notifier<void>())
        const field = (name: string, min: number, max: number, step: number, format: OpenDrumControls.Format,
                       key: keyof OpenDrumSynth.Clap): OpenDrumControls.Field =>
            ({name, get: () => clap[key], set: value => clap[key] = value, range: {min, max, step, format}})
        const choice = (name: string, choices: ReadonlyArray<string>, key: keyof OpenDrumSynth.Clap): OpenDrumControls.Field =>
            ({name, get: () => clap[key], set: value => clap[key] = value, choices})
        const groups: ReadonlyArray<HTMLElement> = [
            group(lifecycle, refresh, "orange", "Hands", 1, [
                field("Hands", 1, 8, 1, Formats.fixed(0, ""), "hands"),
                field("Gap", 0, 0.05, 0.0005, Formats.seconds, "gap"),
                field("Last", 0.3, 1.5, 0.01, Formats.fixed(2, ""), "last"),
                field("Spread", 0, 1, 0.01, Formats.percent, "spread")
            ]),
            group(lifecycle, refresh, "yellow", "Burst", 1, [
                field("Attack", 0, 0.005, 0.0001, Formats.seconds, "attack"),
                field("Decay", 0.002, 0.2, 0.001, Formats.seconds, "decay"),
                field("Snap", 0, 1, 0.01, Formats.percent, "snap"),
                field("Drive", 0, 36, 0.5, Formats.decibel, "drive")
            ]),
            group(lifecycle, refresh, "purple", "Tone", 1, [
                field("Tone", 300, 8000, 10, Formats.hertz, "tone"),
                field("Reso", 0, 1, 0.01, Formats.percent, "resonance")
            ]),
            group(lifecycle, refresh, "green", "Room", 1, [
                field("Level", -48, 0, 0.5, Formats.decibel, "room"),
                field("Decay", 0.02, 2, 0.01, Formats.seconds, "roomDecay"),
                field("Tail", 0, 1, 0.01, Formats.percent, "tail")
            ]),
            group(lifecycle, refresh, "cream", "Play", 1, [
                field("Volume", -36, 6, 0.5, Formats.decibel, "volume"),
                field("Velocity", 0, 1, 0.01, Formats.percent, "velocity"),
                choice("Mode", PlayModes, "play")
            ])
        ]
        return {name, color: Colors.purple, groups, refresh, reference, poly: () => clap.play === 1,
            render: () => renderer.map(loaded => loaded.renderClap(clap))}
    }
    let renderer: Option<OpenDrumSynth.Renderer> = Option.None
    let status: string = "loading the engine"
    // newest engine on top
    const devices: ReadonlyArray<Device> = [
        // set from the measured pitch fall, decay, harmonics and noise of the references (2026-11-13)
        tomDevice("Tom (808 low)", {
            tune: 88, pitch: 0.4, sweep: 0.05, drift: 0, decay: 0.62, punch: 0, shape: 0, drive: 0, sub: 0, ratio: 0.67,
            top: 0, length: 0.2, noise: -34, noiseDecay: 0.7, color: 0, air: 0, volume: 0, velocity: 0.5, play: 0, glide: 0
        }, "TR808WAV/LT/LT50.WAV"),
        tomDevice("Tom (909 low)", {
            tune: 74.4, pitch: 4.8, sweep: 0.0246, drift: 2.1, decay: 0.7, punch: 0, shape: 1, drive: 0, sub: 0.3,
            ratio: 0.67, top: 0.8, length: 0.2, noise: -16, noiseDecay: 0.25, color: 0.3, air: 0.35, volume: -2, velocity: 0.5,
            play: 0, glide: 0
        }, "Roland TR-909/LT3D3.WAV"),
        tomDevice("Tom (909 high)", {
            tune: 113.1, pitch: 4.3, sweep: 0.0254, drift: 2.2, decay: 0.5, punch: 0, shape: 1, drive: 0, sub: 0.25,
            ratio: 0.69, top: 0.7, length: 0.2, noise: -30, noiseDecay: 0.25, color: 0.5, air: 0.35, volume: -2, velocity: 0.5,
            play: 0, glide: 0
        }, "Roland TR-909/HT3D3.WAV"),
        // fitted to CP and HANDCLP1: band and high envelopes, spectra of bursts and room (scratchpad clap_fit2.py)
        clapDevice("Clap (808)", {
            hands: 4, gap: 0.0115, last: 0.71, spread: 0, attack: 0.00075, decay: 0.019, snap: 0.6, drive: 0,
            tone: 1055, resonance: 1, room: -1.25, roomDecay: 0.41, tail: 0.5, volume: -2, velocity: 0.5, play: 0
        }, "TR808WAV/CP/CP.WAV"),
        clapDevice("Clap (909)", {
            hands: 4, gap: 0.0116, last: 0.885, spread: 0, attack: 0, decay: 0.0255, snap: 0, drive: 0,
            tone: 865, resonance: 0.36, room: -3.25, roomDecay: 0.72, tail: 0, volume: 0, velocity: 0.5, play: 0
        }, "Roland TR-909/HANDCLP1.WAV"),
        // 808 fitted by `fit_snare SD5050`, 909 set against the measured tone and noise of ST3T3S3 (2026-11-13)
        snareDevice("Snare (808 fit)", {
            tune: 171.16, ratio: 1.943, balance: 0.7243, pitch: 2.065, sweep: 0.0092, decay: 0.2093, punch: -0.0221,
            shape: 0, level: -5.3, wireDecay: 0.1944, width: 0.46, curve: -0.2745, click: 0.1079, tone: 4779,
            skin: 0.1612, drive: 0, volume: 0, velocity: 0.5, play: 0, glide: 0
        }, "TR808WAV/SD/SD5050.WAV"),
        snareDevice("Snare (909)", {
            tune: 145, ratio: 1.5, balance: 0.292, pitch: 9.7, sweep: 0.0078, decay: 0.188, punch: 0,
            shape: 0.5, level: -23.7, wireDecay: 0.1394, width: 0.81, curve: 1, click: 0, tone: 759,
            skin: 0, drive: 0, volume: 0, velocity: 0.5, play: 0, glide: 0
        }, "Roland TR-909/ST3T3S3.WAV"),
        // fitted by `cargo run -p opendrum-lab --release --bin fit_kick -- BD5050 BT3AADA` (2026-11-13)
        kickDevice("Kick (808 fit)", {
            tune: 51.43, pitch: 28.23, sweep: 0.0025, drift: 4.1, decay: 1.137, punch: 0.078, shape: 0.001,
            click: 0.034, tone: 873.1, skin: 0.295, rumble: 0, length: 2, duck: 1, drive: 0.82, velocity: 0.5, play: 0,
            bright: 0.25, volume: 0, noise: 0.5, glide: 0
        }, "TR808WAV/BD/BD5050.WAV"),
        kickDevice("Kick (909 fit)", {
            tune: 46.84, pitch: 26.68, sweep: 0.0106, drift: 2.04, decay: 0.708, punch: -0.477, shape: 0.352,
            click: 0.342, tone: 1013.3, skin: 0.144, rumble: 0, length: 2, duck: 1, drive: 3.25, velocity: 0.5, play: 0,
            bright: 0.25, volume: 0, noise: 0.5, glide: 0
        }, "Roland TR-909/BT3AADA.WAV")
    ]
    OpenDrumSynth.load().then(loaded => {
        renderer = Option.wrap(loaded)
        devices.forEach(device => device.refresh.notify())
    }, (error: unknown) => {
        status = "engine not built, run build-wasm.sh"
        console.warn(error)
        devices.forEach(device => device.refresh.notify())
    })
    // Mono and Gate cut the sounding hit like the engine's one voice does (5 ms fade), Poly lets hits overlap
    const createPlayer = (poly: Provider<boolean>, target: AudioNode) => {
        let sounding: Option<[AudioBufferSourceNode, GainNode]> = Option.None
        return (samples: Float32Array): void => {
            const now = audioContext.currentTime
            if (!poly()) {
                sounding.ifSome(([source, gain]) => {
                    gain.gain.setValueAtTime(gain.gain.value, now)
                    gain.gain.linearRampToValueAtTime(0.0, now + 0.005)
                    source.stop(now + 0.006)
                })
            }
            const buffer = audioContext.createBuffer(1, samples.length, OpenDrumSynth.SampleRate)
            buffer.getChannelData(0).set(samples)
            const source = audioContext.createBufferSource()
            const gain = audioContext.createGain()
            source.buffer = buffer
            source.connect(gain).connect(target)
            if (audioContext.state !== "running") {audioContext.resume().then()}
            source.start(now)
            sounding = Option.wrap([source, gain])
        }
    }
    const createDevice = ({name, color, render, groups, refresh, reference, poly}: Device): HTMLElement => {
        const filters = [audioContext.createBiquadFilter(), audioContext.createBiquadFilter()]
        filters.forEach(filter => {
            filter.type = "highpass"
            filter.frequency.value = OpenFilterHz
        })
        filters[0].connect(filters[1]).connect(audioContext.destination)
        const play = createPlayer(poly, filters[0])
        const audio: HTMLAudioElement = (
            <audio controls preload="auto" src={`${import.meta.env.BASE_URL}opendrum-references/${encodeURI(reference)}`}/>
        )
        const referenceGain = audioContext.createGain()
        referenceGain.gain.value = OpenDrumSynth.Headroom
        audioContext.createMediaElementSource(audio).connect(referenceGain).connect(filters[0])
        const noiseOnly = lifecycle.own(new DefaultObservableValue(false))
        const canvas: HTMLCanvasElement = <canvas/>
        const length: HTMLElement = <span className="length"/>
        let hit: Option<OpenDrumSynth.Hit> = render()
        const painter = lifecycle.own(new CanvasPainter(canvas, ({context, actualWidth, actualHeight, devicePixelRatio}) => {
            const width = actualWidth * devicePixelRatio
            const height = actualHeight * devicePixelRatio
            const middle = height / 2
            const frames = OpenDrumSynth.MaxSeconds * OpenDrumSynth.SampleRate
            context.clearRect(0, 0, width, height)
            if (hit.isEmpty()) {return}
            const {samples, envelope, pitch, softPitch} = hit.unwrap()
            context.fillStyle = Colors.shadow.opacity(0.2).toString()
            context.fillRect(0, Math.round(middle), width, devicePixelRatio)
            context.fillStyle = color.opacity(0.5).toString()
            for (let x = 0; x < width; x++) {
                const from = Math.floor(x / width * frames)
                const to = Math.min(samples.length, Math.floor((x + 1) / width * frames))
                if (from >= samples.length) {break}
                let min = 0.0
                let max = 0.0
                for (let index = from; index < to; index++) {
                    min = Math.min(min, samples[index])
                    max = Math.max(max, samples[index])
                }
                const top = middle - Math.min(1.0, max) * (middle - devicePixelRatio)
                const bottom = middle - Math.max(-1.0, min) * (middle - devicePixelRatio)
                context.fillRect(x, top, 1, Math.max(devicePixelRatio, bottom - top))
            }
            const curve = (values: Float32Array, scale: number, style: string, dash: ReadonlyArray<number>): void => {
                if (values.length === 0) {return}
                context.strokeStyle = style
                context.lineWidth = devicePixelRatio
                context.setLineDash(dash.map(value => value * devicePixelRatio))
                context.beginPath()
                for (let x = 0; x < width; x++) {
                    const index = Math.floor(x / width * frames)
                    if (index >= values.length) {break}
                    const y = middle - values[index] * scale * (middle - devicePixelRatio)
                    if (x === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
                }
                context.stroke()
            }
            curve(envelope, 1.0, color.opacity(0.9).toString(), [])
            curve(softPitch, 1.0, Colors.cream.opacity(0.35).toString(), [2, 2])
            curve(pitch, 1.0, Colors.cream.opacity(0.9).toString(), [])
            context.setLineDash([])
        }))
        const update = (): void => {
            hit = render()
            length.textContent = hit.match({
                none: () => status,
                some: ({samples}) => Formats.seconds.print(samples.length / OpenDrumSynth.SampleRate).join(" ")
            })
            painter.requestUpdate()
        }
        lifecycle.ownAll(
            refresh.subscribe(update),
            Events.subscribe(canvas, "pointerdown", () => hit.ifSome(({samples}) => play(samples))),
            Events.subscribe(audio, "play", () => {if (audioContext.state !== "running") {audioContext.resume().then()}}),
            noiseOnly.catchupAndSubscribe(owner => filters.forEach(filter =>
                filter.frequency.value = owner.getValue() ? NoiseOnlyHz : OpenFilterHz))
        )
        update()
        const panel = PreviewDevicePanel.create([PreviewDevicePanel.editor({
            lifecycle, name: `openDrum ${name}`, icon: IconSymbol.OpenDAW, type: "instrument",
            controls: (
                <div className={className}>
                    <div className="display">{canvas}{length}</div>
                    <div className="groups">{groups}</div>
                </div>
            )
        })])
        return (
            <div className={referenceClassName}>
                {panel}
                <div className="reference">
                    {audio}
                    <Checkbox lifecycle={lifecycle} model={noiseOnly} appearance={{cursor: "pointer"}}>
                        <span>Noise only</span>
                    </Checkbox>
                </div>
            </div>
        )
    }
    return <Group>{devices.map(device => createDevice(device))}</Group>
}
