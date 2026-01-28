import {TrackContext} from "@/ui/timeline/tracks/audio-unit/TrackContext.ts"
import {
    Arrays,
    asDefined,
    assert,
    BinarySearch,
    DefaultObservableValue,
    int,
    Lifecycle,
    NumberComparator,
    Option,
    SortedSet,
    Terminable,
    Terminator,
    UUID
} from "@moises-ai/lib-std"
import {AudioUnitBoxAdapter, IndexComparator, TrackBoxAdapter} from "@moises-ai/studio-adapters"
import {RegionModifier} from "@/ui/timeline/tracks/audio-unit/regions/RegionModifier.ts"
import {StudioService} from "@/service/StudioService.ts"
import {AudioUnitTracks} from "@/ui/timeline/tracks/audio-unit/AudioUnitTracks.tsx"
import {ClipModifier} from "./clips/ClipModifier"
import {Dragging} from "@moises-ai/lib-dom"
import {ExtraSpace} from "@/ui/timeline/tracks/audio-unit/Constants"

export interface TrackFactory {
    create(manager: TracksManager,
           lifecycle: Lifecycle,
           audioUnitBoxAdapter: AudioUnitBoxAdapter,
           trackBoxAdapter: TrackBoxAdapter): HTMLElement
}

export class TracksManager implements Terminable {
    readonly #service: StudioService
    readonly #scrollContainer: Element
    readonly #factory: TrackFactory

    readonly #terminator: Terminator
    readonly #audioUnits: SortedSet<UUID.Bytes, { uuid: UUID.Bytes, unitTracks: HTMLElement, lifecycle: Terminable }>
    readonly #tracks: SortedSet<UUID.Bytes, TrackContext>
    readonly #maxClipsIndex: DefaultObservableValue<int>

    #currentClipModifier: Option<ClipModifier> = Option.None
    #currentRegionModifier: Option<RegionModifier> = Option.None
    #orderedByIndex: Option<ReadonlyArray<TrackContext>> = Option.None

    constructor(service: StudioService, scrollContainer: Element, factory: TrackFactory) {
        this.#service = service
        this.#scrollContainer = scrollContainer
        this.#factory = factory

        this.#terminator = new Terminator()
        this.#audioUnits = UUID.newSet(({uuid}) => uuid)
        this.#tracks = UUID.newSet(({trackBoxAdapter: {uuid}}) => uuid)
        this.#maxClipsIndex = this.#terminator.own(new DefaultObservableValue(8))
        this.#terminator.own(this.#subscribe())
    }

    startClipModifier(option: Option<ClipModifier>): Option<Dragging.Process> {
        return option.map(modifier => {
            assert(this.#currentClipModifier.isEmpty(), "ClipModifier already in use.")
            this.service.regionModifierInProgress = true
            const lifeTime = this.#terminator.spawn()
            lifeTime.own({terminate: () => this.#currentClipModifier = Option.None})
            this.#currentClipModifier = option
            return {
                update: (event: Dragging.Event): void => modifier.update(event),
                approve: (): void => modifier.approve(this.#service.project.editing),
                cancel: (): void => modifier.cancel(),
                finally: (): void => {
                    this.service.regionModifierInProgress = false
                    lifeTime.terminate()
                }
            }
        })
    }

    startRegionModifier(option: Option<RegionModifier>): Option<Dragging.Process> {
        const print = () => option.unwrapOrNull()?.toString() ?? "unknown"
        console.debug(`start(${print()})`)
        return option.map(modifier => {
            assert(this.#currentRegionModifier.isEmpty(), "RegionModifier already in use.")
            this.service.regionModifierInProgress = true
            const lifeTime = this.#terminator.spawn()
            lifeTime.own({terminate: () => this.#currentRegionModifier = Option.None})
            this.#currentRegionModifier = option
            return {
                update: (event: Dragging.Event): void => modifier.update(event),
                approve: (): void => {
                    console.debug(`approve(${print()})`)
                    modifier.approve(this.#service.project.editing)
                },
                cancel: (): void => {
                    console.debug(`cancel(${print()})`)
                    modifier.cancel()
                },
                finally: (): void => {
                    console.debug(`finally(${print()})`)
                    this.service.regionModifierInProgress = false
                    lifeTime.terminate()
                }
            }
        })
    }

    get currentClipModifier(): Option<ClipModifier> {return this.#currentClipModifier}
    get currentRegionModifier(): Option<RegionModifier> {return this.#currentRegionModifier}
    get maxClipsIndex(): DefaultObservableValue<number> {return this.#maxClipsIndex}
    get service(): StudioService {return this.#service}

    localToIndex(position: number): int {
        return position > this.tracksLocalBottom()
            ? this.tracks().length
            : Math.max(0, BinarySearch
                .rightMostMapped(this.tracks(), position, NumberComparator, track => track.position))
    }

    globalToIndex(position: number): int {
        return this.localToIndex(position - this.#trackGlobalTop())
    }

    indexToGlobal(index: int): number {
        if (index < 0) {return 0}
        const tracks = this.tracks()
        const offset = this.tracksLocalBottom()
        return asDefined(tracks.at(Math.min(index, tracks.length - 1))).position + offset
    }

    get scrollableContainer(): Element {return this.#scrollContainer}

    getByIndex(index: number): Option<TrackContext> {return Option.wrap(this.tracks()[index])}

    tracks(): ReadonlyArray<TrackContext> {
        if (this.#audioUnits.size() === 0) {return Arrays.empty()}
        if (this.#orderedByIndex.isEmpty()) {
            this.#orderedByIndex = Option.wrap(this.#toSortedTrackScopes())
        }
        return this.#orderedByIndex.unwrap()
    }

    numTracks(): int {return this.tracks().length}

    terminate(): void {
        this.#audioUnits.clear()
        this.#orderedByIndex = Option.None
        this.#terminator.terminate()
    }

    #subscribe(): Terminable {
        const {project} = this.#service
        const {rootBoxAdapter} = project
        return Terminable.many(
            rootBoxAdapter.audioUnits.catchupAndSubscribe({
                onAdd: (audioUnitBoxAdapter: AudioUnitBoxAdapter) => {
                    const audioUnitLifecycle = this.#terminator.spawn()
                    const unitTracks: HTMLElement = AudioUnitTracks({
                        lifecycle: audioUnitLifecycle,
                        project,
                        adapter: audioUnitBoxAdapter
                    })
                    this.#scrollContainer.appendChild(unitTracks)
                    audioUnitLifecycle.ownAll(
                        {
                            terminate: () => {
                                this.#tracks.values()
                                    .filter(scope => scope.audioUnitBoxAdapter === audioUnitBoxAdapter)
                                    .forEach(scope => this.#tracks.removeByKey(scope.trackBoxAdapter.uuid).lifecycle.terminate())
                                unitTracks.remove()
                                this.#invalidateOrder()
                            }
                        },
                        audioUnitBoxAdapter.tracks.catchupAndSubscribe({
                            onAdd: (trackBoxAdapter: TrackBoxAdapter) => {
                                const trackLifecycle = audioUnitLifecycle.spawn()
                                const element = this.#factory.create(this, trackLifecycle, audioUnitBoxAdapter, trackBoxAdapter)
                                unitTracks.appendChild(element)
                                const track = new TrackContext({
                                    audioUnitBoxAdapter,
                                    trackBoxAdapter,
                                    element,
                                    lifecycle: trackLifecycle
                                })
                                this.#tracks.add(track)
                                trackLifecycle.own({terminate: () => element.remove()})
                                this.#invalidateOrder()
                            },
                            onRemove: ({uuid}) => {
                                this.#tracks.removeByKey(uuid).lifecycle.terminate()
                                this.#invalidateOrder()
                            },
                            onReorder: () => this.#invalidateOrder()
                        })
                    )
                    this.#audioUnits.add({
                        uuid: audioUnitBoxAdapter.uuid,
                        unitTracks,
                        lifecycle: audioUnitLifecycle
                    })
                    this.#invalidateOrder()
                },
                onRemove: (audioUnitBoxAdapter) => {
                    this.#audioUnits.removeByKey(audioUnitBoxAdapter.uuid).lifecycle.terminate()
                    this.#invalidateOrder()
                },
                onReorder: () => this.#invalidateOrder()
            })
        )
    }

    #invalidateOrder(): void {
        this.#orderedByIndex = Option.None
        this.tracks().forEach(({trackBoxAdapter}, index) => trackBoxAdapter.listIndex = index)
    }

    #toSortedTrackScopes(): ReadonlyArray<TrackContext> {
        return this.#tracks.values()
            .toSorted((a: TrackContext, b: TrackContext) => {
                const diff = IndexComparator(
                    a.audioUnitBoxAdapter.indexField.getValue(),
                    b.audioUnitBoxAdapter.indexField.getValue())
                if (diff !== 0) {return diff}
                return IndexComparator(a.trackBoxAdapter.indexField.getValue(), b.trackBoxAdapter.indexField.getValue())
            })
    }

    #trackGlobalTop() {return this.#scrollContainer.getBoundingClientRect().top - this.#scrollContainer.scrollTop}
    tracksLocalBottom(): number {return this.#scrollContainer.scrollHeight - ExtraSpace}
}