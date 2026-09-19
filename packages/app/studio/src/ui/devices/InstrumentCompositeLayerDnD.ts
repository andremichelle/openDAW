import {int, isDefined, Nullable, Optional, Provider, Subscription, UUID} from "@opendaw/lib-std"
import {EffectBox, EffectFactories, Project} from "@opendaw/studio-core"
import {
    DeviceHost, InstrumentCompositeBoxAdapter, InstrumentCompositeCellBoxAdapter, InstrumentFactories, InstrumentFactory
} from "@opendaw/studio-adapters"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"

// All drag & drop of an Instrument Composite's layers in one place:
//   - REORDER: drag a layer by its icons onto another layer of the SAME composite.
//   - NEW INSTRUMENT from the browser: onto a layer's top / bottom edge (or the Add Layer footer, or the empty
//     list) creates a NEW layer there, onto its MIDDLE replaces that layer's instrument.
//   - An EFFECT, new from the browser or dragged out of a chain: appended to that layer's chain of its kind.
export namespace InstrumentCompositeLayerDnD {
    type HandleConstruct = {
        handle: HTMLElement
        classReceiver: HTMLElement
        composite: InstrumentCompositeBoxAdapter
        uuid: UUID.Bytes
        getIndex: Provider<int>
    }

    export const installHandle = ({handle, classReceiver, composite, uuid, getIndex}: HandleConstruct): Subscription =>
        DragAndDrop.installSource(handle, () => ({
            type: "composite-entry",
            uuid: UUID.toString(uuid),
            index: getIndex(),
            composite: UUID.toString(composite.uuid)
        } satisfies AnyDragData), classReceiver)

    type TargetConstruct = {
        element: HTMLElement
        project: Project
        composite: InstrumentCompositeBoxAdapter
        layer: InstrumentCompositeCellBoxAdapter
        getIndex: Provider<int>
    }

    export const installTarget = ({element, project, composite, layer, getIndex}: TargetConstruct): Subscription =>
        DragAndDrop.installTarget(element, {
            drag: (event: DragEvent, data: AnyDragData): boolean => {
                if (data.type === "composite-entry") {
                    if (data.composite !== UUID.toString(composite.uuid) || data.index === getIndex()) {return false}
                    mark(element, data.index < getIndex() ? "insert-after" : "insert-before")
                    return true
                }
                if (isDefined(layerFactoryOf(data))) {
                    const zone = zoneOf(event, element)
                    mark(element, zone === "before" ? "insert-before" : zone === "after" ? "insert-after" : "drop-target")
                    return true
                }
                if (acceptsEffect(project, layer, data)) {
                    mark(element, "drop-target")
                    return true
                }
                return false
            },
            drop: (event: DragEvent, data: AnyDragData): void => {
                mark(element, null)
                const {editing, api} = project
                if (data.type === "composite-entry") {
                    event.preventDefault()
                    editing.modify(() => api.moveCompositeLayer(composite.box, data.index, getIndex()))
                    return
                }
                const factory = layerFactoryOf(data)
                if (isDefined(factory)) {
                    event.preventDefault()
                    const zone = zoneOf(event, element)
                    editing.modify(() => zone === "onto"
                        ? api.setLayerInstrument(layer.box, factory)
                        : api.createCompositeLayer(composite.box, factory, undefined, zone === "before" ? getIndex() : getIndex() + 1))
                    return
                }
                if (!acceptsEffect(project, layer, data) || (data.type !== "audio-effect" && data.type !== "midi-effect")) {return}
                event.preventDefault()
                const field = DeviceHost.chainFieldOf(layer, data.type === "audio-effect" ? "audio" : "midi").unwrap("layer chain")
                const insertIndex = field.pointerHub.incoming().length
                if (data.uuids === null) {
                    const effectFactory = EffectFactories.MergedNamed[data.device]
                    if (isDefined(effectFactory)) {editing.modify(() => api.insertEffect(field, effectFactory, insertIndex))}
                } else {
                    const boxes = resolveEffectBoxes(project, data.uuids, data.type)
                    editing.modify(() => api.moveEffects(field, boxes, insertIndex))
                }
            },
            enter: () => {},
            leave: () => mark(element, null)
        })

    type AppendConstruct = {
        element: HTMLElement
        project: Project
        composite: InstrumentCompositeBoxAdapter
        active?: Provider<boolean>
    }

    // The Add Layer footer and the EMPTY list: a dropped instrument becomes a new last layer.
    export const installAppendTarget = ({element, project, composite, active}: AppendConstruct): Subscription =>
        DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => (active?.() ?? true) && isDefined(layerFactoryOf(data)),
            drop: (event: DragEvent, data: AnyDragData): void => {
                element.classList.remove("drop-target")
                const factory = layerFactoryOf(data)
                if (active?.() === false || !isDefined(factory)) {return}
                event.preventDefault()
                project.editing.modify(() => project.api.createCompositeLayer(composite.box, factory))
            },
            enter: (allowDrop: boolean) => element.classList.toggle("drop-target", allowDrop),
            leave: () => element.classList.remove("drop-target")
        })

    // The instrument a drag would put into a layer: a NEW one from the browser that can live in a layer.
    const layerFactoryOf = (data: AnyDragData): Optional<InstrumentFactory> => {
        if (data.type !== "instrument" || data.device === null) {return undefined}
        const factory: Optional<InstrumentFactory> = InstrumentFactories.Named[data.device]
        return isDefined(factory) && InstrumentFactories.isLayerInstrument(factory) ? factory : undefined
    }

    // A dragged effect can never contain the layer it is dropped on (an effect hosts effects only), so there
    // is no cycle to guard. The layer must take that KIND: a midi effect needs a note instrument in the layer.
    const acceptsEffect = (project: Project, layer: InstrumentCompositeCellBoxAdapter, data: AnyDragData): boolean => {
        if (data.type !== "audio-effect" && data.type !== "midi-effect") {return false}
        if (!DeviceHost.takesEffect(layer, data.type === "audio-effect" ? "audio" : "midi")) {return false}
        return data.uuids === null || resolveEffectBoxes(project, data.uuids, data.type).length > 0
    }

    const resolveEffectBoxes = (project: Project, uuids: ReadonlyArray<UUID.String>,
                                deviceType: "audio-effect" | "midi-effect"): ReadonlyArray<EffectBox> =>
        uuids.map(uuid => project.boxGraph.findBox(UUID.parse(uuid)).unwrapOrNull())
            .filter(isDefined)
            .filter((box): box is EffectBox => box.tags.deviceType === deviceType)

    const zoneOf = (event: DragEvent, element: HTMLElement): "before" | "onto" | "after" => {
        const rect = element.getBoundingClientRect()
        const fraction = (event.clientY - rect.top) / rect.height
        return fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : "onto"
    }

    const mark = (element: HTMLElement, cls: Nullable<"insert-before" | "insert-after" | "drop-target">): void => {
        element.classList.toggle("insert-before", cls === "insert-before")
        element.classList.toggle("insert-after", cls === "insert-after")
        element.classList.toggle("drop-target", cls === "drop-target")
    }
}
