import {int, isDefined, Optional, Provider, Subscription, UUID} from "@opendaw/lib-std"
import {EffectFactories, Project} from "@opendaw/studio-core"
import {
    DeviceHost, InstrumentCompositeBoxAdapter, InstrumentCompositeCellBoxAdapter, InstrumentFactories, InstrumentFactory
} from "@opendaw/studio-adapters"
import {DragAndDrop} from "@/ui/DragAndDrop"
import {AnyDragData} from "@/ui/AnyDragData"
import {CompositeRows} from "@/ui/devices/CompositeRows"

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
                    CompositeRows.mark(element, data.index < getIndex() ? "insert-after" : "insert-before")
                    return true
                }
                if (isDefined(layerFactoryOf(data))) {
                    const zone = CompositeRows.zoneOf(event, element)
                    CompositeRows.mark(element, zone === "before" ? "insert-before" : zone === "after" ? "insert-after" : "drop-target")
                    return true
                }
                if (acceptsEffect(project, layer, data)) {
                    CompositeRows.mark(element, "drop-target")
                    return true
                }
                return false
            },
            drop: (event: DragEvent, data: AnyDragData): void => {
                CompositeRows.mark(element, null)
                const {editing, api} = project
                if (data.type === "composite-entry") {
                    event.preventDefault()
                    editing.modify(() => api.moveCompositeLayer(composite.box, data.index, getIndex()))
                    return
                }
                const factory = layerFactoryOf(data)
                if (isDefined(factory)) {
                    event.preventDefault()
                    const zone = CompositeRows.zoneOf(event, element)
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
                    const boxes = CompositeRows.resolveEffectBoxes(project, data.uuids, data.type)
                    editing.modify(() => api.moveEffects(field, boxes, insertIndex))
                }
            },
            enter: () => {},
            leave: () => CompositeRows.mark(element, null)
        })

    type AppendConstruct = {
        element: HTMLElement
        project: Project
        composite: InstrumentCompositeBoxAdapter
        active?: Provider<boolean>
    }

    export const installAppendTarget = ({element, project, composite, active = () => true}: AppendConstruct): Subscription =>
        DragAndDrop.installTarget(element, {
            drag: (_event: DragEvent, data: AnyDragData): boolean => active() && isDefined(layerFactoryOf(data)),
            drop: (event: DragEvent, data: AnyDragData): void => {
                element.classList.remove("drop-target")
                const factory = layerFactoryOf(data)
                if (!active() || !isDefined(factory)) {return}
                event.preventDefault()
                project.editing.modify(() => project.api.createCompositeLayer(composite.box, factory))
            },
            enter: (allowDrop: boolean) => element.classList.toggle("drop-target", allowDrop),
            leave: () => element.classList.remove("drop-target")
        })

    const layerFactoryOf = (data: AnyDragData): Optional<InstrumentFactory> => {
        if (data.type !== "instrument" || !isDefined(data.device)) {return undefined}
        const factory: Optional<InstrumentFactory> = InstrumentFactories.Named[data.device]
        return isDefined(factory) && InstrumentFactories.isLayerInstrument(factory) ? factory : undefined
    }

    // no cycle guard: an effect hosts effects only, it can never contain the layer
    const acceptsEffect = (project: Project, layer: InstrumentCompositeCellBoxAdapter, data: AnyDragData): boolean => {
        if (data.type !== "audio-effect" && data.type !== "midi-effect") {return false}
        if (!DeviceHost.takesEffect(layer, data.type === "audio-effect" ? "audio" : "midi")) {return false}
        return !isDefined(data.uuids) || CompositeRows.resolveEffectBoxes(project, data.uuids, data.type).length > 0
    }
}
