import {
    asInstanceOf,
    MutableObservableValue,
    Notifier,
    ObservableValue,
    Observer,
    Option,
    SortedSet,
    Subscription,
    Terminable,
    Terminator,
    UUID
} from "@opendaw/lib-std"
import {Propagation} from "@opendaw/lib-box"
import {AudioUnitBox, TrackBox, UserInterfaceBox, ViewStateBox} from "@opendaw/studio-boxes"

type Entry = {uuid: UUID.Bytes, subscription: Subscription}

export class ViewStates implements Terminable {
    readonly #terminator: Terminator
    readonly #following: Terminator
    readonly #notifier: Notifier<void>
    readonly #entries: SortedSet<UUID.Bytes, Entry>

    #user: Option<UserInterfaceBox> = Option.None

    constructor() {
        this.#terminator = new Terminator()
        this.#following = this.#terminator.own(new Terminator())
        this.#notifier = this.#terminator.own(new Notifier<void>())
        this.#entries = UUID.newSet(entry => entry.uuid)
    }

    follow(userInterfaceBox: UserInterfaceBox): void {
        this.#release()
        this.#user = Option.wrap(userInterfaceBox)
        this.#following.ownAll(
            userInterfaceBox.mixerMidiEffectsCollapsed.subscribe(() => this.#notifier.notify()),
            userInterfaceBox.mixerAudioEffectsCollapsed.subscribe(() => this.#notifier.notify()))
        this.#following.own(userInterfaceBox.viewStates.pointerHub.catchupAndSubscribe({
            onAdded: pointer => {
                const {box} = pointer
                this.#entries.add({uuid: box.address.uuid, subscription: box.subscribe(Propagation.Children, () => this.#notifier.notify())})
                this.#notifier.notify()
            },
            onRemoved: pointer => {
                this.#entries.removeByKeyIfExist(pointer.box.address.uuid)?.subscription.terminate()
                this.#notifier.notify()
            }
        }))
        this.#notifier.notify()
    }

    groupCollapsed(unit: AudioUnitBox): MutableObservableValue<boolean> {
        return this.#value(unit, box => box.groupCollapsed.getValue(), (box, value) => box.groupCollapsed.setValue(value), false)
    }

    automationCollapsed(unit: AudioUnitBox): MutableObservableValue<boolean> {
        return this.#value(unit, box => box.automationCollapsed.getValue(), (box, value) => box.automationCollapsed.setValue(value), false)
    }

    height(target: AudioUnitBox | TrackBox): MutableObservableValue<number> {
        return this.#value(target, box => box.height.getValue(), (box, value) => box.height.setValue(value), 0)
    }

    mixerEffectsCollapsed(kind: "midi" | "audio"): MutableObservableValue<boolean> {
        const field = (user: UserInterfaceBox) => kind === "midi" ? user.mixerMidiEffectsCollapsed : user.mixerAudioEffectsCollapsed
        return this.#observable(
            () => this.#user.mapOr(user => field(user).getValue(), false),
            value => this.#user.ifSome(user => field(user).setValue(value)))
    }

    subscribe(observer: Observer<void>): Subscription {return this.#notifier.subscribe(observer)}

    terminate(): void {
        this.#release()
        this.#terminator.terminate()
    }

    #release(): void {
        this.#following.terminate()
        this.#entries.forEach(entry => entry.subscription.terminate())
        this.#entries.clear()
        this.#user = Option.None
    }

    #entry(target: AudioUnitBox | TrackBox): Option<ViewStateBox> {
        return this.#user.flatMap(user => Option.wrap(user.viewStates.pointerHub.incoming()
            .map(pointer => asInstanceOf(pointer.box, ViewStateBox))
            .find(entry => entry.target.targetVertex.mapOr(vertex => vertex.box === target, false))))
    }

    #value<T>(target: AudioUnitBox | TrackBox, read: (box: ViewStateBox) => T,
              write: (box: ViewStateBox, value: T) => void, fallback: T): MutableObservableValue<T> {
        return this.#observable(() => this.#entry(target).mapOr(read, fallback), value => this.#entry(target).match({
            none: () => {
                if (value === fallback) {return}
                this.#user.ifSome(user => write(ViewStateBox.create(user.graph, UUID.generate(), box => {
                    box.target.refer(target)
                    box.user.refer(user.viewStates)
                }), value))
            },
            some: box => write(box, value)
        }))
    }

    #observable<T>(read: () => T, write: (value: T) => void): MutableObservableValue<T> {
        const notifier = this.#notifier
        return new class implements MutableObservableValue<T> {
            getValue(): T {return read()}
            setValue(value: T): void {write(value)}
            subscribe(observer: Observer<ObservableValue<T>>): Subscription {
                let last = this.getValue()
                return notifier.subscribe(() => {
                    const next = this.getValue()
                    if (next === last) {return}
                    last = next
                    observer(this)
                })
            }
            catchupAndSubscribe(observer: Observer<ObservableValue<T>>): Subscription {
                observer(this)
                return this.subscribe(observer)
            }
        }
    }
}
