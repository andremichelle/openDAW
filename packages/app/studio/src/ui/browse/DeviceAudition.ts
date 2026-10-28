import {
    DefaultObservableValue, Errors, isDefined, isInstanceOf, MutableObservableOption, Option, RuntimeNotifier, Terminable, tryCatch
} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {BoxEditing, EditingCheckpoint} from "@opendaw/lib-box"
import type {StudioService} from "@/service/StudioService"
import {DeviceCandidate, DeviceEntry} from "@/ui/browse/DeviceCatalog"
import {DeviceSlot} from "@/ui/browse/DeviceSlot"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {NewInstrumentRegion} from "@/ui/timeline/NewInstrumentRegion"

// every pick is applied right away from the state before opening, approve keeps the last one as ONE undo step
export class DeviceAudition implements Terminable {
    readonly #service: StudioService
    readonly #slot: DeviceSlot
    readonly #candidates = new Map<string, Promise<DeviceCandidate>>()
    readonly #applied = new MutableObservableOption<DeviceEntry>()
    readonly #loading = new DefaultObservableValue(false)

    #checkpoint: Option<EditingCheckpoint> = Option.None
    #current: Option<DeviceCandidate> = Option.None
    #generation: number = 0
    #pending: Promise<void> = Promise.resolve()

    constructor(service: StudioService, slot: DeviceSlot) {
        this.#service = service
        this.#slot = slot
    }

    get applied(): MutableObservableOption<DeviceEntry> {return this.#applied}
    get loading(): DefaultObservableValue<boolean> {return this.#loading}

    // resolves true when the download was cancelled, the previous pick then stays
    pick(entry: DeviceEntry): Promise<boolean> {
        const generation = ++this.#generation
        const cancelled = {value: false}
        this.#loading.setValue(true)
        this.#pending = this.#candidateOf(entry).then(async candidate => {
            if (generation !== this.#generation) {return}
            this.#rollback()
            if (!this.#apply(candidate, true)) {
                this.#applied.clear()
                return
            }
            this.#applied.wrap(entry)
            await this.#settle(candidate, entry.name)
        }, reason => {
            if (generation !== this.#generation) {return}
            if (Errors.isAbort(reason)) {
                cancelled.value = true
                return
            }
            console.warn(reason)
            RuntimeNotifier.notify({message: `Could not load ${entry.name}.`, icon: "Warning"})
        }).finally(() => {if (generation === this.#generation) {this.#loading.setValue(false)}})
        return this.#pending.then(() => cancelled.value && generation === this.#generation)
    }

    async approve(): Promise<void> {
        await this.#pending
        const candidate = this.#current
        if (candidate.mapOr(({offersTimeline}) => offersTimeline, false)) {
            const choice = await Promises.tryCatch(RuntimeNotifier.approve({
                headline: "Replace Timeline?",
                message: "This preset includes timeline content (clips, regions, automation). "
                    + "Replace the existing timeline on this audio unit, or keep your current one?",
                approveText: "Replace",
                cancelText: "Keep"
            }))
            if (choice.status === "resolved" && choice.value) {
                this.#rollback()
                if (this.#apply(candidate.unwrap(), false)) {await this.#settle(candidate.unwrap(), "the preset")}
            }
        }
        this.#generation++
        this.#checkpoint.ifSome(checkpoint => checkpoint.commit())
        this.#checkpoint = Option.None
    }

    cancel(): void {
        this.#generation++
        this.#rollback()
        this.#applied.clear()
    }

    terminate(): void {this.cancel()}

    #candidateOf(entry: DeviceEntry): Promise<DeviceCandidate> {
        const cached = this.#candidates.get(entry.key)
        if (isDefined(cached)) {return cached}
        const loading = entry.prepare()
        loading.catch(() => this.#candidates.delete(entry.key))
        this.#candidates.set(entry.key, loading)
        return loading
    }

    #apply(candidate: DeviceCandidate, keepTimeline: boolean): boolean {
        const {project} = this.#service
        const {editing} = project
        this.#checkpoint = Option.wrap(isInstanceOf(editing, BoxEditing) ? editing.checkpoint() : {
            rollback: () => editing.revertPending(),
            commit: () => editing.mark()
        })
        this.#current = Option.wrap(candidate)
        const result = tryCatch(() => editing.modify(() => {
            const applied = candidate.apply(project, this.#slot, keepTimeline)
            if (applied && this.#slot.type === "new-instrument") {
                project.userEditingManager.audioUnit.get().ifSome(({box}) => {
                    if (isInstanceOf(box, AudioUnitBox)) {
                        NewInstrumentRegion.create(project, this.#service.timeline.snapping, box)
                    }
                })
            }
            return applied
        }, false))
        if (result.status === "success" && result.value.unwrapOrElse(false)) {return true}
        if (result.status === "failure") {console.warn(result.error)}
        this.#rollback()
        RuntimeNotifier.notify({message: "This does not fit here.", icon: "Info"})
        return false
    }

    async #settle(candidate: DeviceCandidate, name: string): Promise<void> {
        const result = await Promises.tryCatch(candidate.settle(this.#service))
        if (result.status === "rejected") {
            console.warn(result.error)
            RuntimeNotifier.notify({message: `Could not finish ${name}.`, icon: "Warning"})
        }
    }

    #rollback(): void {
        this.#checkpoint.ifSome(checkpoint => {
            const result = tryCatch(() => checkpoint.rollback())
            if (result.status === "failure") {
                console.warn(result.error)
                RuntimeNotifier.notify({message: "Could not revert, the project changed meanwhile.", icon: "Warning"})
            }
        })
        this.#checkpoint = Option.None
        this.#current = Option.None
    }
}
