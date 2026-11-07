import css from "./KeyControl.sass?inline"
import {Arrays, byte, DefaultObservableValue, int, isDefined, Lifecycle, Nullable, Terminable, Terminator} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {ChordDetection, Harmony, MidiKeys} from "@opendaw/lib-dsp"
import {MidiData} from "@opendaw/lib-midi"
import {ContextMenu, MenuItem, MidiDevices} from "@opendaw/studio-core"
import {UnitDisplay} from "@/ui/header/UnitDisplay"
import {StudioService} from "@/service/StudioService"
import {Events, Html} from "@opendaw/lib-dom"
import {GlobalShortcuts} from "@/ui/shortcuts/GlobalShortcuts"

const className = Html.adoptStyleSheet(css, "KeyControl")
const NaturalMinorBits: int = 0b010110101101

// a held chord with a major third sets a major key, one with only a minor third a natural minor key
const keyOfChord = (held: ReadonlySet<int>): Nullable<Harmony.Key> => {
    if (held.size < 3) {return null}
    const weights = new Float64Array(12)
    held.forEach(pitch => weights[pitch % 12] = 1)
    return ChordDetection.detectChord(weights, Math.min(...held)).mapOr(({root, bits}) =>
        (bits & (1 << 4)) !== 0 ? {root, bits: Harmony.MajorBits}
            : (bits & (1 << 3)) !== 0 ? {root, bits: NaturalMinorBits} : null, null)
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const KeyControl = ({lifecycle, service}: Construct) => {
    const {projectProfileService, timeline: {primaryVisibility: {key: keyVisible, chords: chordsVisible}}} = service
    const unitString = lifecycle.own(new DefaultObservableValue("C"))
    const projectActiveLifeTime = lifecycle.own(new Terminator())
    return (
        <UnitDisplay lifecycle={lifecycle} name="key" value={unitString} numChars={4} onInit={element => {
            element.classList.add(className)
            lifecycle.own(projectProfileService.catchupAndSubscribe(optProfile => {
                projectActiveLifeTime.terminate()
                if (optProfile.isEmpty()) {
                    unitString.setValue(MidiKeys.Names.English[Harmony.DefaultKey.root])
                    element.firstElementChild?.setAttribute("data-scale", Harmony.scaleAbbreviation(Harmony.DefaultKey.bits))
                    element.removeAttribute("title")
                    element.classList.remove("automated")
                    return
                }
                const {project} = optProfile.unwrap()
                const {editing, engine, timelineBoxAdapter: {keyTrack}} = project
                const updateKeyLabel = () => {
                    const key = keyTrack.keyAt(engine.position.getValue())
                    unitString.setValue(MidiKeys.Names.English[key.root])
                    element.firstElementChild?.setAttribute("data-scale", Harmony.scaleAbbreviation(key.bits))
                    element.title = `${Harmony.keyName(key)}. Click to listen: a played chord sets the project key`
                    element.classList.toggle("automated", keyTrack.enabled && !keyTrack.events.isEmpty())
                }
                updateKeyLabel()
                const listening = projectActiveLifeTime.own(new Terminator())
                const held = new Set<int>()
                const onMidi = (data: Nullable<Uint8Array>) => MidiData.accept(data, {
                    noteOn: (pitch: byte) => {
                        held.add(pitch)
                        const key = keyOfChord(held)
                        if (!isDefined(key)) {return}
                        const {root, scale} = keyTrack.object
                        if (root.getValue() === key.root && scale.getValue() === key.bits) {return}
                        editing.modify(() => {
                            root.setValue(key.root)
                            scale.setValue(key.bits)
                        })
                    },
                    noteOff: (pitch: byte) => {held.delete(pitch)}
                })
                projectActiveLifeTime.ownAll(
                    Terminable.create(() => element.classList.remove("listening")),
                    Events.subscribe(element, "click", () => {
                        held.clear()
                        if (listening.nonEmpty()) {
                            listening.terminate()
                            element.classList.remove("listening")
                            return
                        }
                        element.classList.add("listening")
                        MidiDevices.available().setValue(true)
                        listening.ownAll(
                            MidiDevices.subscribeMessageEvents(event => onMidi(event.data)),
                            Events.subscribe(MidiDevices.softwareMIDIInput, "midimessage",
                                (event: MIDIMessageEvent) => onMidi(event.data)))
                    }),
                    keyTrack.subscribe(updateKeyLabel),
                    engine.position.subscribe(updateKeyLabel),
                    ContextMenu.subscribe(element, (collector: ContextMenu.Collector) => {
                        const current = keyTrack.storageKey
                        const {root, scale} = keyTrack.object
                        collector.addItems(
                            MenuItem.default({label: "Root"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                                ...Arrays.create(index => MenuItem.default({
                                    label: MidiKeys.Names.English[index],
                                    checked: index === current.root
                                }).setTriggerProcedure(() => editing.modify(() => root.setValue(index))), 12))),
                            MenuItem.default({label: "Scale"}).setRuntimeChildrenProcedure(parent => parent.addMenuItem(
                                ...MidiKeys.StockScales.map(stock => MenuItem.default({
                                    label: stock.name,
                                    checked: stock.bits === current.bits
                                }).setTriggerProcedure(() => editing.modify(() => scale.setValue(stock.bits)))))),
                            MenuItem.default({label: "Show Key Track", checked: keyVisible.getValue(),
                                shortcut: GlobalShortcuts["toggle-key-track"].shortcut.format()})
                                .setTriggerProcedure(() => keyVisible.setValue(!keyVisible.getValue())),
                            MenuItem.default({label: "Show Chord Track", checked: chordsVisible.getValue(),
                                shortcut: GlobalShortcuts["toggle-chord-track"].shortcut.format()})
                                .setTriggerProcedure(() => chordsVisible.setValue(!chordsVisible.getValue())))
                    })
                )
            }))
        }}/>
    )
}
