import css from "./PropertyTable.sass?inline"
import {
    Arrays,
    Editing,
    int,
    isDefined,
    isNotNull,
    Lifecycle,
    Nullable,
    Option,
    Selection,
    Subscription,
    Terminable
} from "@opendaw/lib-std"
import {deferNextFrame, Html} from "@opendaw/lib-dom"
import {TimeCodeInput} from "@/ui/components/TimeCodeInput.tsx"
import {PropertyParameters} from "@/ui/timeline/editors/notes/property/PropertyParameters.ts"
import {NumberInput} from "@/ui/components/NumberInput.tsx"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {MidiKeys} from "@opendaw/lib-dsp"
import {NoteEventBoxAdapter, NoteEventCollectionBoxAdapter} from "@opendaw/studio-adapters"
import {IconSymbol} from "@opendaw/studio-enums"
import {ObservableModifyContext} from "@/ui/timeline/ObservableModifyContext.ts"
import {NoteModifier} from "@/ui/timeline/editors/notes/NoteModifier.ts"
import {NoteModifyStrategies, NoteModifyStrategy} from "@/ui/timeline/editors/notes/NoteModifyStrategies.ts"
import {Icon} from "@/ui/components/Icon.tsx"
import {DigitDragging} from "@/ui/components/DigitDragging.ts"

const className = Html.adoptStyleSheet(css, "PropertyTable")

export type NotePropertyKey = keyof typeof PropertyParameters

interface PropertyCell {
    readonly key: NotePropertyKey
    readonly icon: IconSymbol
    readonly input: Element
    readonly element: Element
    readonly connect: boolean
    raw(adapter: NoteEventBoxAdapter): number
    read(strategy: NoteModifyStrategy, adapter: NoteEventBoxAdapter): number
}

type Construct = {
    lifecycle: Lifecycle
    selection: Selection<NoteEventBoxAdapter>
    modifyContext: ObservableModifyContext<NoteModifier>
    editing: Editing
    rows: ReadonlyArray<ReadonlyArray<NotePropertyKey>>
}

export const PropertyTable = ({lifecycle, selection, modifyContext, editing, rows}: Construct) => {
    let dragging = false
    const drag: DigitDragging.Hooks = {
        begin: () => {
            editing.mark()
            dragging = true
        },
        end: () => {
            dragging = false
            editing.mark()
        }
    }
    const numberCell = (key: NotePropertyKey, icon: IconSymbol, unit: string | Inject.Value<string>,
                        {raw, read}: Pick<PropertyCell, "raw" | "read">,
                        stepped: boolean, connect: boolean): PropertyCell => {
        const {parameter} = PropertyParameters[key]
        const input: Element = stepped
            ? <NumberInput lifecycle={lifecycle} model={parameter} mapper={parameter.stringMapping} step={0.01}
                           drag={drag}/>
            : <NumberInput lifecycle={lifecycle} model={parameter} drag={drag}/>
        const element: Element = (
            <div className={Html.buildClassList("group", connect && "connect")}>
                {input}
                <div className="unit">{unit}</div>
                {connect && <hr/>}
            </div>
        )
        return {key, icon, input, element, connect, raw, read}
    }
    const createCell = (key: NotePropertyKey): PropertyCell => {
        switch (key) {
            case "position": {
                const input: Element = <TimeCodeInput lifecycle={lifecycle}
                                                      model={PropertyParameters.position.parameter}
                                                      negativeWarning
                                                      oneBased
                                                      drag={drag}/>
                return {
                    key, icon: IconSymbol.Start, input, element: input, connect: false,
                    raw: adapter => adapter.position,
                    read: (strategy, adapter) => strategy.readPosition(adapter)
                }
            }
            case "duration": {
                const input: Element = <TimeCodeInput lifecycle={lifecycle}
                                                      model={PropertyParameters.duration.parameter}
                                                      negativeWarning
                                                      drag={drag}/>
                return {
                    key, icon: IconSymbol.Duration, input, element: input, connect: false,
                    raw: adapter => adapter.duration,
                    read: (strategy, adapter) => strategy.readComplete(adapter) - strategy.readPosition(adapter)
                }
            }
            case "pitch": {
                const {parameter} = PropertyParameters.pitch
                const pitchString = Inject.value(MidiKeys.toFullString(parameter.getValue()))
                lifecycle.own(parameter.subscribe(owner => pitchString.value = MidiKeys.toFullString(owner.getValue())))
                return numberCell(key, IconSymbol.Piano, pitchString, {
                    raw: adapter => adapter.pitch,
                    read: (strategy, adapter) => strategy.readPitch(adapter)
                }, false, false)
            }
            case "velocity":
                return numberCell(key, IconSymbol.Velocity, "%", {
                    raw: adapter => adapter.velocity,
                    read: (strategy, adapter) => strategy.readVelocity(adapter)
                }, true, false)
            case "cent":
                return numberCell(key, IconSymbol.Dial, "cents", {
                    raw: adapter => adapter.cent,
                    read: (strategy, adapter) => strategy.readCent(adapter)
                }, false, false)
            case "chance":
                return numberCell(key, IconSymbol.Random, "%", {
                    raw: adapter => adapter.chance,
                    read: (strategy, adapter) => strategy.readChance(adapter)
                }, false, false)
            case "playCount":
                return numberCell(key, IconSymbol.Divide, "#", {
                    raw: adapter => adapter.playCount,
                    read: (_strategy, adapter) => adapter.playCount
                }, false, true)
            case "playCurve":
                return numberCell(key, IconSymbol.Curve, "%", {
                    raw: adapter => adapter.playCurve,
                    read: (_strategy, adapter) => adapter.playCurve
                }, true, false)
            case "repeatLength":
                return numberCell(key, IconSymbol.Duration, "%", {
                    raw: adapter => adapter.repeatLength,
                    read: (_strategy, adapter) => adapter.repeatLength
                }, true, false)
            case "velocityFade":
                return numberCell(key, IconSymbol.Velocity, "%", {
                    raw: adapter => adapter.velocityFade,
                    read: (_strategy, adapter) => adapter.velocityFade
                }, true, false)
        }
    }
    const cellRows: ReadonlyArray<ReadonlyArray<PropertyCell>> = rows.map(row => row.map(createCell))
    const cells: ReadonlyArray<PropertyCell> = cellRows.flat()
    const element: HTMLElement = (
        <div className={className}>
            {cellRows.map(row => row.map((cell, index) => [
                <Icon symbol={cell.icon} className={index === 0 ? "row-start" : undefined}/>,
                cell.element,
                index < row.length - 1 && !cell.connect && <div/>
            ]))}
        </div>
    )
    let focus: Nullable<NoteEventBoxAdapter> = null
    const updateState = lifecycle.own(deferNextFrame(() => {
        if (selection.isEmpty()) {
            element.classList.add("disabled")
            cells.forEach(cell => cell.input.classList.remove("invalid"))
        } else {
            element.classList.remove("disabled")
            const adapters = selection.selected()
            cells.forEach(cell => cell.input.classList
                .toggle("invalid", !Arrays.satisfy(adapters, (first, other) => cell.raw(first) === cell.raw(other))))
            if (isNotNull(focus)) {
                const modifier: Option<NoteModifyStrategies> = modifyContext.modifier
                const strategy = modifier.unwrapOrElse(NoteModifyStrategies.Identity).selectedModifyStrategy()
                const adapter = focus
                ignore = true
                cells.forEach(cell => PropertyParameters[cell.key].parameter.setValue(cell.read(strategy, adapter)))
                ignore = false
            }
        }
    }))
    let ignore = false
    const noteCollections = new Map<NoteEventBoxAdapter, NoteEventCollectionBoxAdapter>()
    const collectionWatches = new Map<NoteEventCollectionBoxAdapter, { count: int, subscription: Subscription }>()
    lifecycle.ownAll(...cells
            .map(({key}) => {
                const {parameter, write} = PropertyParameters[key]
                return parameter.subscribe(owner => {
                    if (ignore) {return}
                    editing.modify(() =>
                        selection.selected()
                            .forEach(adapter => write(adapter.box, owner.getValue())), !dragging)
                })
            }),
        selection.catchupAndSubscribe({
            onSelected: (adapter: NoteEventBoxAdapter) => {
                adapter.collection.ifSome(collection => {
                    noteCollections.set(adapter, collection)
                    const watch = collectionWatches.get(collection)
                    if (isDefined(watch)) {
                        watch.count++
                    } else {
                        collectionWatches.set(collection,
                            {count: 1, subscription: collection.subscribeChange(updateState.request)})
                    }
                })
                focus = adapter
                updateState.request()
            },
            onDeselected: (adapter: NoteEventBoxAdapter) => {
                const collection = noteCollections.get(adapter)
                noteCollections.delete(adapter)
                if (isDefined(collection)) {
                    const watch = collectionWatches.get(collection)
                    if (isDefined(watch) && --watch.count === 0) {
                        watch.subscription.terminate()
                        collectionWatches.delete(collection)
                    }
                }
                if (focus === adapter) {focus = null}
                updateState.request()
            }
        }),
        modifyContext.subscribeUpdate(updateState.request),
        editing.subscribe(updateState.request),
        Terminable.create(() => {
            collectionWatches.forEach(({subscription}) => subscription.terminate())
            collectionWatches.clear()
            noteCollections.clear()
        })
    )
    updateState.immediate()
    return element
}