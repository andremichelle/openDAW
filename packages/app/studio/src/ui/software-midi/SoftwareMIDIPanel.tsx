import css from "./SoftwareMIDIPanel.sass?inline"
import {Dragging, Events, Html, Shortcut, ShortcutManager} from "@opendaw/lib-dom"
import {
    Arrays,
    asInstanceOf,
    byte,
    clamp,
    DefaultObservableValue,
    int,
    isDefined,
    isInstanceOf,
    isUndefined,
    Lifecycle,
    Nullable,
    Option,
    ParseResult,
    Predicates,
    StringResult,
    Terminable
} from "@opendaw/lib-std"
import {createElement, DomElement} from "@opendaw/lib-jsx"
import {PianoRollLayout} from "@/ui/PianoRollLayout"
import {MenuItem, MidiDevices} from "@opendaw/studio-core"
import {AudioUnitBoxAdapter} from "@opendaw/studio-adapters"
import {NumberInput} from "@/ui/components/NumberInput"
import {MenuButton} from "@/ui/components/MenuButton"
import {Icon} from "@/ui/components/Icon"
import {Colors, IconSymbol} from "@opendaw/studio-enums"
import {MidiData} from "@opendaw/lib-midi"
import {Harmony} from "@opendaw/lib-dsp"
import {Checkbox} from "@/ui/components/Checkbox"
import {FlexSpacer} from "@/ui/components/FlexSpacer"
import {PianoRoll} from "@/ui/software-midi/PianoRoll"
import {Button} from "@/ui/components/Button"
import {StudioService} from "@/service/StudioService"
import {AudioUnitBox, CaptureMidiBox} from "@opendaw/studio-boxes"
import {Surface} from "@/ui/surface/Surface"
import {ChordShortcuts, NoteShortcuts, SoftwareMIDIShortcuts} from "@/ui/shortcuts/SoftwareMIDIShortcuts"
import {ChordPadPlayer} from "@/ui/software-midi/ChordPadPlayer"
import {ChordPads} from "@/ui/software-midi/ChordPads"

const className = Html.adoptStyleSheet(css, "SoftwareMIDIPanel")

const octave = new DefaultObservableValue(5, {guard: (value: number): number => clamp(value, 0, 10)})
const channel = new DefaultObservableValue(0, {guard: (value: number): number => clamp(value, 0, 15)})
const velocity = new DefaultObservableValue(100, {guard: (value: number): number => clamp(value, 0, 100)})
const scaleMapping = new DefaultObservableValue(false)
const WhiteKeys: ReadonlyArray<int> = [0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6]

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const SoftwareMIDIPanel = ({lifecycle, service}: Construct) => {
    const numKeys = 18
    const pianoLayout = new PianoRollLayout(0, numKeys - 1, {
        whiteKeys: {width: 23, height: 48},
        blackKeys: {width: 19, height: 24}
    })
    const {softwareMIDIInput} = MidiDevices
    const pitchOf = (key: int): Nullable<int> => {
        const base = octave.getValue() * 12
        if (!scaleMapping.getValue()) {return base + key}
        const white = WhiteKeys[key % 12]
        if (white === -1) {return null}
        const {root, bits} = service.projectProfileService.getValue()
            .mapOr(({project: {engine, timelineBoxAdapter: {keyTrack}}}) =>
                keyTrack.keyAt(engine.position.getValue()), Harmony.DefaultKey)
        const steps = Arrays.create(index => index, 12).filter(index => (bits & (1 << index)) !== 0)
        const step = white + Math.floor(key / 12) * 7
        return base + root + steps[step % steps.length] + Math.floor(step / steps.length) * 12
    }
    const svg: SVGElement = (<PianoRoll lifecycle={lifecycle} pianoLayout={pianoLayout}/>)
    const chordPlayer = lifecycle.own(new ChordPadPlayer(service, octave, velocity))
    const midiIndicator: DomElement = <Icon symbol={IconSymbol.Connected}/>
    const element: HTMLElement = <div className={className}>
        <header>
            <span>MIDI Keyboard</span>
            <Button lifecycle={lifecycle} onClick={() => service.toggleSoftwareKeyboard()}
                    appearance={{color: Colors.shadow, tooltip: "Close MIDI Keyboard"}}>
                <Icon symbol={IconSymbol.Close}/>
            </Button>
        </header>
        <div className="controls">
            <div className="unit">
                <span>Oct</span>
                <NumberInput lifecycle={lifecycle} model={octave} mapper={{
                    x: (y: byte): StringResult => ({unit: "", value: String(y - 2)}),
                    y: (x: string): ParseResult<byte> => ({
                        type: "explicit",
                        value: parseInt(x) + 2
                    })
                }} className="octave"/>
            </div>
            <div className="unit">
                <span>Ch</span>
                <NumberInput lifecycle={lifecycle} model={channel} mapper={{
                    x: (y: byte): StringResult => ({unit: "", value: String(y + 1)}),
                    y: (x: string): ParseResult<byte> => ({
                        type: "explicit",
                        value: parseInt(x) - 1
                    })
                }} className="channel"/>
            </div>
            <div className="unit">
                <span>Vel</span>
                <NumberInput lifecycle={lifecycle} model={velocity} mapper={{
                    x: (y: byte): StringResult => ({unit: "", value: String(y)}),
                    y: (x: string): ParseResult<byte> => ({
                        type: "explicit",
                        value: parseInt(x)
                    })
                }} className="velocity"/>
            </div>
            <div className="unit">
                <span>Scale</span>
                <Checkbox lifecycle={lifecycle} model={scaleMapping} className="scale"
                          appearance={{color: Colors.shadow, activeColor: Colors.orange,
                              tooltip: "White keys play the steps of the key at the play position"}}>
                    <Icon symbol={IconSymbol.Checkbox}/>
                </Checkbox>
            </div>
            <FlexSpacer/>
            <MenuButton root={MenuItem.root()
                .setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                    ...service.projectProfileService.getValue()
                        .map(({project: {boxAdapters, captureDevices, rootBox: {audioUnits: {pointerHub}}}}) =>
                            pointerHub.incoming()
                                .map(({box}) => asInstanceOf(box, AudioUnitBox))
                                .filter(box => box.capture.targetVertex
                                    .mapOr(({box}) => isInstanceOf(box, CaptureMidiBox), false))
                                .map(box => {
                                    const {label, uuid} = boxAdapters.adapterFor(box, AudioUnitBoxAdapter)
                                    return captureDevices.get(uuid).match({
                                        none: () => MenuItem.default({label, selectable: false}),
                                        some: (capture) => MenuItem.default({
                                            label,
                                            checked: capture.armed.getValue()
                                        }).setTriggerProcedure(() => captureDevices.setArm(capture, true))
                                    })
                                }))
                        .map(adapters => adapters.length === 0 ? undefined : adapters)
                        .match({
                            none: () => [MenuItem.default({label: "No MIDI instruments found"})],
                            some: adapters => adapters
                        })
                ))} appearance={{
                tinyTriangle: true,
                tooltip: "Click to connect to MIDI instruments."
            }}>{midiIndicator}</MenuButton>
        </div>
        <div className="piano">
            {svg}
        </div>
        <ChordPads lifecycle={lifecycle} service={service} player={chordPlayer}/>
    </div>
    const activeKeys: Int8Array = new Int8Array(numKeys).fill(-1)
    let lastPointerKey = -1
    let lastPointerKeyPitch = -1
    const stopPointerNote = () => {
        if (lastPointerKeyPitch !== -1) {
            softwareMIDIInput.sendNoteOff(lastPointerKeyPitch)
            lastPointerKey = -1
            lastPointerKeyPitch = -1
        }
    }
    const pointerPlayListener = (event: PointerEvent) => {
        if (event.buttons === 0) {return}
        if (isInstanceOf(event.target, SVGRectElement)) {
            const rect = event.target as SVGRectElement
            const dataKey = rect.dataset.key
            if (isUndefined(dataKey)) {return}
            const key = parseInt(dataKey)
            if (lastPointerKey === key) {return}
            stopPointerNote()
            const pitch = pitchOf(key)
            if (isDefined(pitch) && pitch >= 0 && pitch < 128) {
                softwareMIDIInput.sendNoteOn(pitch)
                lastPointerKey = key
                lastPointerKeyPitch = pitch
            }
        }
    }
    const shortcuts = ShortcutManager.get()
        .createContext(Predicates.alwaysTrue, "SoftwareMIDIPanel", Number.MAX_SAFE_INTEGER)
    const activeCodes = new Map<string, int>()
    const activeChordCodes = new Map<string, int>()
    const playNote = (shortcut: Shortcut, index: int) => {
        activeCodes.set(shortcut.code, index)
        if (activeKeys[index] > -1) {
            softwareMIDIInput.sendNoteOff(activeKeys[index])
            activeKeys[index] = -1
        } else {
            const pitch = pitchOf(index)
            if (isDefined(pitch) && pitch >= 0 && pitch < 128) {
                softwareMIDIInput.sendNoteOn(pitch, velocity.getValue() / 100.0)
                activeKeys[index] = pitch
            }
        }
    }
    lifecycle.ownAll(
        Events.subscribe(softwareMIDIInput, "midimessage", event => {
            const update = () => {
                for (let key = 0; key < numKeys; key++) {
                    const note = pitchOf(key)
                    svg.querySelector(`[data-key="${key}"]`)
                        ?.classList.toggle("active", isDefined(note) && note >= 0 && note < 128
                            && softwareMIDIInput.hasActiveNote(note))
                }
            }
            MidiData.accept(event.data, {
                noteOn: (_note: byte, _velocity: byte) => update(),
                noteOff: (_note: byte) => update()
            })
        }),
        softwareMIDIInput.countListeners.catchupAndSubscribe(owner =>
            midiIndicator.style.color = owner.getValue() > 1 ? Colors.green.toString() : Colors.red.toString()),
        shortcuts,
        scaleMapping.catchupAndSubscribe(owner => svg.classList.toggle("scale-mapped", owner.getValue())),
        shortcuts.register(SoftwareMIDIShortcuts["increment-octave"].shortcut, () => octave.setValue(octave.getValue() + 1)),
        shortcuts.register(SoftwareMIDIShortcuts["decrement-octave"].shortcut, () => octave.setValue(octave.getValue() - 1)),
        ...NoteShortcuts.map(({shortcut}, index) => shortcuts.register(shortcut, () => playNote(shortcut, index))),
        ...ChordShortcuts.map(({shortcut}, index) => shortcuts.register(shortcut, () => {
            activeChordCodes.set(shortcut.code, index + 1)
            if (chordPlayer.isActive(index + 1)) {chordPlayer.release(index + 1)} else {chordPlayer.press(index + 1)}
        })),
        Surface.subscribeKeyboard("keyup", event => {
            const degree = activeChordCodes.get(Shortcut.resolveCode(event)) ?? -1
            if (degree > 0 && chordPlayer.isActive(degree)) {
                chordPlayer.release(degree)
                event.preventDefault()
                return
            }
            const index = activeCodes.get(Shortcut.resolveCode(event)) ?? -1
            if (index >= 0) {
                if (activeKeys[index] === -1) {return}
                softwareMIDIInput.sendNoteOff(activeKeys[index])
                activeKeys[index] = -1
                event.preventDefault()
            }
        }, Number.MAX_SAFE_INTEGER),
        Events.subscribe(element, "pointerdown", event => {
            pointerPlayListener(event)
            // we do not use setPointerCapture here because we do want a simple way to detect a drag onto a key.
            const subscription = Terminable.many(
                Events.subscribe(window, "pointermove", pointerPlayListener, {capture: true}),
                Events.subscribe(window, "pointerup", () => {
                    subscription.terminate()
                    stopPointerNote()
                }, {capture: true})
            )
        }, {capture: true}),
        Dragging.attach(element, ({clientX: startX, clientY: startY, target}: PointerEvent) => {
            if (target !== element) {return Option.None}
            const {top, left, width, height} = element.getBoundingClientRect()
            return Option.wrap({
                update: ({clientX, clientY}: Dragging.Event) => {
                    const newX = clamp(left + (clientX - startX), 1, window.innerWidth - width - 1)
                    const newY = clamp(top + (clientY - startY), 1, window.innerHeight - height - 1)
                    element.style.transform = `translate(${newX}px, ${newY}px)`
                }
            })
        }),
        Terminable.create(() => softwareMIDIInput.releaseAllNotes())
    )
    return element
}