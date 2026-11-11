import css from "./ChordKeysPreview.sass?inline"
import {DefaultObservableValue, Func, int, isDefined, isInstanceOf, Lifecycle, Optional, Predicates, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html, Shortcut, ShortcutManager} from "@opendaw/lib-dom"
import {Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {CanvasPainter} from "@opendaw/studio-core"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {ChordKeysDeviceBoxAdapter, NoteSignal} from "@opendaw/studio-adapters"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {Checkbox} from "@/ui/components/Checkbox"
import {DropDown} from "@/ui/composite/DropDown"
import {Icon} from "@/ui/components/Icon"
import {Surface} from "@/ui/surface/Surface"
import {TextTooltip} from "@/ui/surface/TextTooltip"
import {ChordKeysKeyboard} from "@/ui/devices/midi-effects/ChordKeys/ChordKeysKeyboard"

const className = Html.adoptStyleSheet(css, "ChordKeysPreview")

const Roman: ReadonlyArray<string> = ["I", "II", "III", "IV", "V", "VI", "VII"]
const InputLow: int = 48
const OutputOctaves: int = 3
const ComputerKeys: Readonly<Record<string, int>> = {
    KeyA: 48, KeyW: 49, KeyS: 50, KeyE: 51, KeyD: 52, KeyF: 53, KeyT: 54, KeyG: 55, KeyY: 56, KeyH: 57, KeyU: 58, KeyJ: 59,
    KeyK: 60, KeyL: 62
}

const helperMaskOf = (pitches: ReadonlyArray<int>): int => ChordKeysDeviceBoxAdapter.Helpers.reduce((mask, {pitchClass}, bit) =>
    pitches.some(pitch => pitch % 12 === pitchClass) ? mask | (1 << bit) : mask, 0)

// the pitches the engine plays, voice leading picks the closest inversion unless the inversion key is held
const voice = (key: Harmony.Key, pressed: int, helperMask: int, voiceLeading: boolean,
               previous: ReadonlyArray<int>): ReadonlyArray<int> => {
    const inversionHeld = (helperMask & (1 << 4)) !== 0
    const first = ChordKeysDeviceBoxAdapter.voicing(key, pressed, helperMask, inversionHeld ? 1 : 0, 0)
    if (!voiceLeading || previous.length === 0 || inversionHeld || first.length === 0) {return first}
    const center = (pitches: ReadonlyArray<int>) => pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length
    const target = center(previous)
    let best = first, distance = Number.MAX_VALUE
    for (let inversion = 0; inversion < first.length; inversion++) {
        for (const shift of [0, -12]) {
            const candidate = ChordKeysDeviceBoxAdapter.voicing(key, pressed, helperMask, inversion, shift)
            if (candidate.length > 0 && Math.abs(center(candidate) - target) < distance) {
                distance = Math.abs(center(candidate) - target)
                best = candidate
            }
        }
    }
    return best
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const ChordKeysPreview = ({lifecycle, service}: Construct) => {
    const follow = lifecycle.own(new DefaultObservableValue(true))
    const root = lifecycle.own(new DefaultObservableValue<int>(0))
    const scale = lifecycle.own(new DefaultObservableValue<int>(Harmony.MajorBits))
    const voiceLeading = lifecycle.own(new DefaultObservableValue(false))
    const held = new Set<int>()
    let sounding: ReadonlyArray<int> = []
    let previous: ReadonlyArray<int> = []
    let outputLow: int = 48
    const currentKey = (): Harmony.Key => follow.getValue()
        ? service.optProject.mapOr(({timelineBoxAdapter, engine}) =>
            timelineBoxAdapter.keyTrack.keyAt(engine.position.getValue()), Harmony.DefaultKey)
        : {root: root.getValue(), bits: scale.getValue()}
    // into the instrument of the track being edited
    const send = (signal: Func<UUID.Bytes, NoteSignal>): void => service.optProject.ifSome(project =>
        project.userEditingManager.audioUnit.get().ifSome(({box}) => {
            if (isInstanceOf(box, AudioUnitBox)) {project.engine.noteSignal(signal(box.address.uuid))}
        }))
    const chordName: HTMLElement = <div className="chord-name"/>
    const degreeNames: ReadonlyArray<HTMLElement> = Roman.map(() => <span/>)
    const fullNames: Array<string> = Roman.map(() => "")
    const degreeCells: ReadonlyArray<HTMLElement> = degreeNames.map((name, index) => (
        <div><span className="number">{String(index + 1)}</span>{name}</div>
    ))
    const toggle = (name: string, model: DefaultObservableValue<boolean>) => {
        const checkbox: HTMLElement = (
            <Checkbox lifecycle={lifecycle} model={model} className="toggle"
                      appearance={{color: Colors.shadow, activeColor: Colors.green, cursor: "pointer"}}>
                <Icon symbol={IconSymbol.Checkbox}/>
            </Checkbox>
        )
        return (
            <div className="parameter switch" onclick={(event: MouseEvent) => {
                if (isInstanceOf(event.target, Node) && checkbox.contains(event.target)) {return}
                model.setValue(!model.getValue())
            }}>
                <div className="name">{name}</div>
                {checkbox}
            </div>
        )
    }
    const rootNames: ReadonlyArray<int> = Array.from({length: 12}, (_, index) => index)
    const rootControl: HTMLElement = (
        <div className="parameter select">
            <div className="name">Root</div>
            <DropDown lifecycle={lifecycle} owner={root} provider={() => rootNames}
                      mapping={index => MidiKeys.Names.English[index]}/>
        </div>
    )
    const scaleControl: HTMLElement = (
        <div className="parameter select wide">
            <div className="name">Scale</div>
            <DropDown lifecycle={lifecycle} owner={scale}
                      provider={() => MidiKeys.StockScales.map(({bits}) => bits)}
                      mapping={bits => Harmony.scaleName(bits)}/>
        </div>
    )
    const output: HTMLCanvasElement = <canvas/>
    const input: HTMLCanvasElement = <canvas/>
    const hint: HTMLElement = <span/>
    const degreeLabel = (pitch: int): string => {
        if (MidiKeys.isBlackKey(pitch)) {
            return ChordKeysDeviceBoxAdapter.Helpers.find(({pitchClass}) => pitchClass === pitch % 12)?.name ?? ""
        }
        const degree = ChordKeysDeviceBoxAdapter.degreeOf(pitch)
        return Harmony.chord(currentKey(), degree, 0, 0).mapOr(chord => {
            const third = (chord.stack[1] ?? 4) % 12
            const fifth = (chord.stack[2] ?? 7) % 12
            const roman = third === 3 ? Roman[degree - 1].toLowerCase() : Roman[degree - 1]
            return fifth === 6 ? `${roman}°` : roman
        }, Roman[degree - 1])
    }
    let inputRects: ReadonlyArray<ChordKeysKeyboard.KeyRect> = []
    const outputPainter = lifecycle.own(new CanvasPainter(output, ({context}) =>
        ChordKeysKeyboard.draw(context, output.width, output.height, outputLow, OutputOctaves, pitch => sounding.includes(pitch), () => "")))
    const inputPainter = lifecycle.own(new CanvasPainter(input, ({context}) => {
        inputRects = ChordKeysKeyboard.draw(context, input.width, input.height, InputLow, 2, pitch => held.has(pitch), degreeLabel)
    }))
    const revoice = () => {
        const pressed = [...held].filter(pitch => !MidiKeys.isBlackKey(pitch)).at(-1)
        const helperMask = helperMaskOf([...held].filter(MidiKeys.isBlackKey))
        const next = isDefined(pressed) ? voice(currentKey(), pressed, helperMask, voiceLeading.getValue(), previous) : []
        sounding.filter(pitch => !next.includes(pitch)).forEach(pitch => send(uuid => NoteSignal.off(uuid, pitch)))
        next.filter(pitch => !sounding.includes(pitch)).forEach(pitch => send(uuid => NoteSignal.on(uuid, pitch, 0.8)))
        sounding = next
        if (next.length > 0 && (Math.min(...next) < outputLow || Math.max(...next) >= outputLow + OutputOctaves * 12)) {
            outputLow = Math.min(Math.max(Math.min(...next) - Math.min(...next) % 12, 0), 128 - OutputOctaves * 12)
        }
        if (isDefined(pressed) && next.length > 0) {
            chordName.textContent = ChordKeysDeviceBoxAdapter.nameOf(currentKey(),
                ChordKeysDeviceBoxAdapter.degreeOf(pressed), helperMask, Math.min(...next))
        }
        chordName.classList.toggle("sounding", next.length > 0)
        if (next.length > 0) {previous = next}
        const degree = isDefined(pressed) ? ChordKeysDeviceBoxAdapter.degreeOf(pressed) - 1 : -1
        degreeCells.forEach((cell, index) => cell.classList.toggle("active", index === degree))
        outputPainter.requestUpdate()
        inputPainter.requestUpdate()
    }
    const press = (pitch: int) => {if (!held.has(pitch)) {held.add(pitch); revoice()}}
    const release = (pitch: int) => {if (held.delete(pitch)) {revoice()}}
    const releaseAll = () => {held.clear(); revoice()}
    const updateKey = () => {
        if (follow.getValue()) {
            const {root: followedRoot, bits} = currentKey()
            root.setValue(followedRoot)
            scale.setValue(bits)
        }
        const key = currentKey()
        if (sounding.length === 0) {
            chordName.textContent = Harmony.chord(key, 1, 0, 0).mapOr(chord => Harmony.chordName(chord), "")
        }
        degreeNames.forEach((name, index) => {
            fullNames[index] = Harmony.chord(key, index + 1, 0, 0).mapOr(chord => Harmony.chordName(chord), "")
            name.textContent = fullNames[index].replace("aug", "+").replace("dim", "°")
        })
        rootControl.classList.toggle("disabled", follow.getValue())
        scaleControl.classList.toggle("disabled", follow.getValue())
        inputPainter.requestUpdate()
    }
    let pointerPitch: Optional<int> = undefined
    const shortcuts = ShortcutManager.get().createContext(Predicates.alwaysTrue, "ChordKeysPreview", Number.MAX_SAFE_INTEGER)
    lifecycle.ownAll(
        follow.subscribe(updateKey),
        root.subscribe(updateKey),
        scale.subscribe(updateKey),
        Events.subscribe(input, "pointerdown", (event: PointerEvent) => {
            const rect = input.getBoundingClientRect()
            const x = (event.clientX - rect.left) * input.width / rect.width
            const y = (event.clientY - rect.top) * input.height / rect.height
            const hit = inputRects.find(({x: left, y: top, w, h}) => x >= left && x < left + w && y >= top && y < top + h)
            if (!isDefined(hit)) {return}
            input.setPointerCapture(event.pointerId)
            pointerPitch = hit.pitch
            press(hit.pitch)
        }),
        Events.subscribe(input, "pointerup", () => {
            if (isDefined(pointerPitch)) {release(pointerPitch)}
            pointerPitch = undefined
        }),
        shortcuts,
        ...degreeCells.map((cell, index) => TextTooltip.default(cell, () => fullNames[index])),
        ...Object.entries(ComputerKeys).map(([code, pitch]) => shortcuts.register(Shortcut.of(code), () => press(pitch))),
        Surface.subscribeKeyboard("keyup", event => {
            const pitch = ComputerKeys[event.code]
            if (isDefined(pitch)) {release(pitch)}
        }),
        {terminate: releaseAll}
    )
    hint.textContent = service.hasProfile
        ? "Plays the instrument of the track you edit."
        : "Open a project to hear the chords through the instrument of the track you edit."
    updateKey()
    return (
        <div className={className}>
            <div className="device">
                <header>
                    <Icon symbol={IconSymbol.Piano}/>
                    <h1>Chord Keys</h1>
                </header>
                <div className="controls">
                    {rootControl}
                    {scaleControl}
                    {toggle("Follow", follow)}
                    {toggle("Voice Leading", voiceLeading)}
                    <div className="keys">
                        {chordName}
                        {output}
                    </div>
                    <div className="degrees">{degreeCells}</div>
                    <div className="hint">White keys play the key's chords, held black keys add 7th, 9th, sus or inversion.</div>
                </div>
            </div>
            <div className="input">
                {input}
                <p>White keys play the chord on their step of the key. Hold a black key for 7th, 9th, sus2, sus4 or the next
                    inversion. Computer keys: A S D F G H J K L for the white keys, W E T Y U for the black keys. {hint}</p>
            </div>
        </div>
    )
}
