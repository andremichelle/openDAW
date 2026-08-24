import {
    Arrays,
    assert,
    DefaultObservableValue,
    int,
    isDefined,
    isNull,
    Lifecycle,
    MutableObservableValue,
    Nullable,
    Option,
    Terminator
} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnyClipBoxAdapter, NoteClipBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {TracksManager} from "@/ui/timeline/tracks/audio-unit/TracksManager.ts"
import {ClipPlaceholder} from "@/ui/timeline/tracks/audio-unit/clips/ClipPlaceholder.tsx"
import {ClipModifyStrategies, ClipModifyStrategy} from "@/ui/timeline/tracks/audio-unit/clips/ClipModifyStrategy.ts"
import {StudioService} from "@/service/StudioService.ts"
import {deferNextFrame} from "@opendaw/lib-dom"
import {ClipLaneClassName} from "@/ui/timeline/tracks/audio-unit/TrackStyles.ts"

const className = ClipLaneClassName

type Cell = {
    readonly terminator: Terminator
    readonly placeholder: HTMLElement
    readonly adapter: MutableObservableValue<Nullable<AnyClipBoxAdapter>>
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    trackManager: TracksManager
    adapter: TrackBoxAdapter
}

export const ClipLane = ({lifecycle, service, trackManager, adapter}: Construct) => {
    const {project, timeline: {clips}} = service
    const container: HTMLElement = (<div className={className}/>)
    const runtime = lifecycle.own(new Terminator())
    const cells: Array<Cell> = []
    const restockPlaceholders = (count: int): void => {
        for (let index = cells.length; index < count; index++) {
            const terminator = lifecycle.spawn()
            const adapter = new DefaultObservableValue<Nullable<AnyClipBoxAdapter>>(null)
            // A cell does not only show clips of THIS lane's track: `populatePlaceholder` borrows through
            // `strategy.translateTrackIndex` while a move runs, and this lane hears removals of its own
            // collection only. So the cell follows the box it actually displays — otherwise a deleted clip
            // stays in the cell until the deferred rebuild, and the painter renders it one frame later
            // against an adapter whose pointers are already gone (live error 1094).
            const deletion = terminator.own(new Terminator())
            terminator.own(adapter.catchupAndSubscribe(owner => {
                deletion.terminate()
                const displayed = owner.getValue()
                if (isNull(displayed)) {return}
                deletion.own(displayed.box.subscribeDeletion(() => adapter.setValue(null)))
            }))
            const placeholder: HTMLElement = (
                <ClipPlaceholder lifecycle={terminator}
                                 project={project}
                                 adapter={adapter}
                                 gridColumn={`${index + 1} / ${index + 2}`}/>
            )
            container.appendChild(placeholder)
            assert(!isDefined(cells[index]), "Cannot restock busy placeholder.")
            cells[index] = {terminator, placeholder, adapter}
        }
    }
    const populatePlaceholder = (): void => {
        const updates: Array<Nullable<{
            clip: AnyClipBoxAdapter,
            selected: boolean,
            mirrored: boolean
        }>> = Arrays.create(() => null, cells.length)
        const update = (strategy: ClipModifyStrategy, filterSelected: boolean, hideSelected: boolean): void => {
            const listIndex = adapter.listIndex
            const translateTrackIndex = strategy.translateTrackIndex(listIndex)
            const optTrack = trackManager.getByIndex(translateTrackIndex)
            if (optTrack.isEmpty()) {return}
            const clips = optTrack.unwrap().trackBoxAdapter.clips.collection.adapters()
            for (const clip of clips) {
                if (clip.isSelected ? hideSelected : !filterSelected) {continue}
                const index = strategy.readClipIndex(clip)
                if (index < cells.length) {
                    const selected = clip.isSelected && !filterSelected
                    const mirrored = strategy.readMirror(clip)
                    updates[index] = {clip, selected, mirrored}
                }
            }
        }
        const modifier: Option<ClipModifyStrategies> = trackManager.currentClipModifier
        const strategies = modifier.unwrapOrElse(ClipModifyStrategies.Identity)
        update(strategies.unselectedModifyStrategy(), true, !strategies.showOrigin())
        update(strategies.selectedModifyStrategy(), false, false)
        updates.forEach((update, index) => {
            if (isDefined(update)) {
                const {clip, selected, mirrored} = update
                const {adapter, placeholder} = cells[index]
                adapter.setValue(clip)
                // Let's override the selection status by knowing the HTML structure 😬
                const clipElement = placeholder.firstElementChild
                clipElement?.classList.toggle("selected", selected)
                clipElement?.classList.toggle("mirrored", mirrored)
            } else {
                cells[index].adapter.setValue(null)
            }
        })
    }
    const depletePlaceholders = (count: int): void => cells
        .splice(count)
        .forEach(({adapter, placeholder, terminator}) => {
            if (isDefined(adapter.getValue())) {adapter.setValue(null)}
            placeholder.remove()
            terminator.terminate()
        })
    const clipsCount = clips.count
    const {request: requestRebuild} = deferNextFrame(() => {
        const count = clipsCount.getValue()
        restockPlaceholders(count)
        populatePlaceholder()
        depletePlaceholders(count)
    })
    lifecycle.own(
        clips.visible.catchupAndSubscribe(owner => {
            runtime.terminate()
            if (owner.getValue()) {
                runtime.ownAll(
                    clipsCount.catchupAndSubscribe(requestRebuild),
                    adapter.clips.subscribeChanges(requestRebuild),
                    adapter.clips.collection.catchupAndSubscribe({
                        onAdd: (_adapter: NoteClipBoxAdapter) => requestRebuild(),
                        onRemove: (removed: NoteClipBoxAdapter) => cells
                            .find(({adapter}) => adapter.getValue() === removed)?.adapter?.setValue(null),
                        onReorder: (_adapter: NoteClipBoxAdapter) => requestRebuild()
                    }),
                    {
                        terminate: () => {
                            cells.forEach(({adapter, placeholder, terminator}) => {
                                adapter.setValue(null)
                                placeholder.remove()
                                terminator.terminate()
                            })
                            Arrays.clear(cells)
                        }
                    }
                )
                requestRebuild()
            }
        })
    )
    return container
}