import {int, Notifier, Observer, SortedSet, Subscription, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {AnyClipBoxAdapter, AudioUnitBoxAdapter, ClipNotification, TrackBoxAdapter} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import type {Project} from "@opendaw/studio-core"
import {GroupClipAppearance} from "./GroupClipAppearance"

export type GroupClipState = "idle" | "waiting" | "playing"

export class GroupClipLauncher implements Terminable {
    readonly #lifecycle: Terminator
    readonly #members: Terminator
    readonly #changes: Notifier<void>
    readonly #playing: SortedSet<UUID.Bytes, UUID.Bytes>
    readonly #waiting: SortedSet<UUID.Bytes, UUID.Bytes>
    #units: ReadonlyArray<AudioUnitBox> = []
    #tracks: ReadonlyArray<TrackBoxAdapter> = []
    constructor(readonly project: Project, readonly group: AudioUnitBox) {
        this.#lifecycle = new Terminator()
        this.#members = this.#lifecycle.own(new Terminator())
        this.#changes = this.#lifecycle.own(new Notifier())
        this.#playing = UUID.newSet(uuid => uuid)
        this.#waiting = UUID.newSet(uuid => uuid)
        this.#lifecycle.ownAll(
            project.audioUnitLayout.value.catchupAndSubscribe(() => this.#refresh()),
            project.engine.subscribeClipNotification(notification => this.#notifyPlayback(notification)),
            project.engine.isPlaying.subscribe(() => this.#changes.notify())
        )
    }
    clips(index: int): ReadonlyArray<AnyClipBoxAdapter> {
        if (!this.group.isAttached()) {return []}
        return this.#tracks.flatMap(track => track.clips.collection.getAdapterByIndex(index).match({none: () => [], some: clip => [clip]}))
    }
    state(index: int): GroupClipState {
        if (!this.project.engine.isPlaying.getValue()) {return "idle"}
        const clips = this.clips(index)
        if (clips.some(clip => this.#waiting.hasKey(clip.uuid))) {return "waiting"}
        return clips.some(clip => this.#playing.hasKey(clip.uuid)) ? "playing" : "idle"
    }
    toggle(index: int): void {
        if (!this.group.isAttached()) {return}
        if (this.state(index) === "idle") {
            const clips = this.clips(index)
            if (clips.length > 0) {this.project.engine.scheduleClipPlay(clips.map(clip => clip.uuid))}
        } else {
            this.project.engine.scheduleClipStop(this.#tracks.map(track => track.uuid))
        }
    }
    rename(index: int, label: string): void {
        if (!this.group.isAttached()) {return}
        this.project.editing.modify(() => GroupClipAppearance.store(this.group, index,
            {...GroupClipAppearance.read(this.group, index), label}))
    }
    isMuted(index: int): boolean {
        const clips = this.clips(index)
        return clips.length > 0 && clips.every(clip => clip.mute)
    }
    setMuted(index: int, muted: boolean): void {
        this.project.editing.modify(() => this.clips(index).forEach(clip => clip.box.mute.setValue(muted)))
    }
    isLooping(index: int): boolean {
        const clips = this.clips(index)
        return clips.length > 0 && clips.every(clip => clip.box.triggerMode.loop.getValue())
    }
    setLooping(index: int, loop: boolean): void {
        this.project.editing.modify(() => this.clips(index).forEach(clip => clip.box.triggerMode.loop.setValue(loop)))
    }
    consolidate(index: int): void {
        this.project.editing.modify(() => this.clips(index).filter(clip => clip.isMirrowed).forEach(clip => clip.consolidate()))
    }
    delete(index: int): void {
        if (!this.group.isAttached()) {return}
        this.project.editing.modify(() => {
            this.clips(index).forEach(clip => clip.box.delete())
            this.#units.filter(unit => unit.isGroup.getValue()).forEach(unit => GroupClipAppearance.clear(unit, index))
        })
    }
    subscribe(observer: Observer<void>): Subscription {return this.#changes.subscribe(observer)}
    #refresh(): void {
        const units = this.project.audioUnitLayout.snapshot.rows.filter(row => row.unit === this.group || row.ancestors.includes(this.group)).map(row => row.unit)
        if (units.length === this.#units.length && units.every((unit, index) => unit === this.#units[index])) {return}
        this.#units = units
        this.#members.terminate()
        const updateTracks = () => {
            this.#tracks = units.flatMap(unit => this.project.boxAdapters.adapterFor(unit, AudioUnitBoxAdapter).tracks.values())
            this.#changes.notify()
        }
        units.forEach(unit => {
            const tracks = this.project.boxAdapters.adapterFor(unit, AudioUnitBoxAdapter).tracks
            const subscriptions = new Map<TrackBoxAdapter, Terminable>()
            this.#members.ownAll(
                {terminate: () => subscriptions.forEach(subscription => subscription.terminate())},
                tracks.catchupAndSubscribe({
                    onAdd: track => {
                        subscriptions.set(track, Terminable.many(
                            track.clips.subscribeChanges(() => this.#changes.notify()),
                            track.enabled.subscribe(() => this.#changes.notify())))
                        updateTracks()
                    },
                    onRemove: track => {
                        subscriptions.get(track)?.terminate()
                        subscriptions.delete(track)
                        updateTracks()
                    },
                    onReorder: updateTracks
                })
            )
        })
        updateTracks()
    }
    #notifyPlayback(notification: ClipNotification): void {
        if (notification.type === "waiting") {
            notification.clips.forEach(uuid => this.#waiting.add(uuid))
        } else {
            const {started, stopped, obsolete} = notification.changes
            stopped.forEach(uuid => {this.#waiting.removeByKeyIfExist(uuid); this.#playing.removeByKeyIfExist(uuid)})
            obsolete.forEach(uuid => this.#waiting.removeByKeyIfExist(uuid))
            started.forEach(uuid => {this.#waiting.removeByKeyIfExist(uuid); this.#playing.add(uuid)})
        }
        this.#changes.notify()
    }
    terminate(): void {this.#lifecycle.terminate()}
}
