import {Address, Int32Field, PointerField, Propagation, StringField} from "@opendaw/lib-box"
import {ppqn} from "@opendaw/lib-dsp"
import {GrooveStackBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {int, Notifier, Observer, Option, Subscription, Terminator, UUID} from "@opendaw/lib-std"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {IndexedBoxAdapterCollection} from "../IndexedBoxAdapterCollection"
import {AutomatableParameterFieldAdapter} from "../AutomatableParameterFieldAdapter"
import {GrooveAdapter, GrooveKind} from "./GrooveBoxAdapter"
import {GrooveStackEntryBoxAdapter} from "./GrooveStackEntryBoxAdapter"

// Stacks nested deeper than this play their inner members straight
const MaxDepth = 16

const greatestCommonDivisor = (a: int, b: int): int => b === 0 ? a : greatestCommonDivisor(b, a % b)
const leastCommonMultiple = (a: int, b: int): int => a / greatestCommonDivisor(a, b) * b

export class GrooveStackBoxAdapter implements GrooveAdapter {
    readonly type = "groove-adapter"

    // the stacks being evaluated, one met again (merged edits of two peers) is skipped
    static readonly #active: Set<GrooveStackBoxAdapter> = new Set()

    readonly #terminator: Terminator = new Terminator()
    readonly #members: Terminator = new Terminator()
    readonly #box: GrooveStackBox
    readonly #entries: IndexedBoxAdapterCollection<GrooveStackEntryBoxAdapter, Pointers.GrooveStackEntries>
    readonly #notifier: Notifier<GrooveAdapter>

    #notifying: boolean = false
    #listening: boolean = false

    constructor(context: BoxAdaptersContext, box: GrooveStackBox) {
        this.#box = box
        this.#notifier = this.#terminator.own(new Notifier<GrooveAdapter>())
        this.#entries = this.#terminator.own(IndexedBoxAdapterCollection.create(box.entries,
            box => context.boxAdapters.adapterFor(box, GrooveStackEntryBoxAdapter), Pointers.GrooveStackEntries))
        this.#terminator.own(this.#members)
        const changed = () => {
            if (this.#listening) {this.#resubscribeMembers()}
            this.#notify()
        }
        this.#terminator.ownAll(
            this.#entries.subscribe({onAdd: changed, onRemove: changed, onReorder: changed}),
            box.subscribe(Propagation.Children, () => this.#notify())
        )
    }

    get kind(): GrooveKind {return "stack"}
    get box(): GrooveStackBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get label(): string {return this.#box.label.getValue()}
    get labelField(): StringField {return this.#box.label}
    get indexField(): Int32Field {return this.#box.index}
    get amount(): Option<AutomatableParameterFieldAdapter<number>> {return Option.None}
    get duration(): Option<AutomatableParameterFieldAdapter<int>> {return Option.None}
    get entries(): IndexedBoxAdapterCollection<GrooveStackEntryBoxAdapter, Pointers.GrooveStackEntries> {
        return this.#entries
    }

    members(): ReadonlyArray<GrooveAdapter> {
        return this.#entries.adapters().flatMap(entry => entry.groove().mapOr(groove => [groove], []))
    }

    // The span every member fits into whole, the shorter ones repeat (their least common multiple)
    cellDuration(): ppqn {
        return this.#guarded(0, () => this.members()
            .map(member => Math.round(member.cellDuration()))
            .filter(duration => duration > 0)
            .reduce((result, duration) => result === 0 ? duration : leastCommonMultiple(result, duration), 0))
    }

    warp(position: ppqn): ppqn {
        return this.#guarded(position, () => this.members().reduce((value, groove) => groove.warp(value), position))
    }

    unwarp(position: ppqn): ppqn {
        return this.#guarded(position, () => this.members()
            .reduceRight((value, groove) => groove.unwarp(value), position))
    }

    // members are followed once someone listens, never while adapters are built (stacks that hold each other)
    subscribeChange(observer: Observer<GrooveAdapter>): Subscription {
        const subscription = this.#notifier.subscribe(observer)
        if (!this.#listening) {
            this.#listening = true
            this.#resubscribeMembers()
        }
        return {
            terminate: () => {
                subscription.terminate()
                if (this.#notifier.isEmpty()) {
                    this.#listening = false
                    this.#members.terminate()
                }
            }
        }
    }

    users(): ReadonlyArray<PointerField<Pointers.Groove>> {
        return this.#box.pointerHub.filter(Pointers.Groove) as ReadonlyArray<PointerField<Pointers.Groove>>
    }

    terminate(): void {this.#terminator.terminate()}

    #guarded(position: ppqn, compute: () => ppqn): ppqn {
        const active = GrooveStackBoxAdapter.#active
        if (active.has(this) || active.size >= MaxDepth) {return position}
        active.add(this)
        const result = compute()
        active.delete(this)
        return result
    }

    static #reaches(groove: GrooveAdapter, target: GrooveStackBoxAdapter, visited: Set<GrooveAdapter>): boolean {
        if (groove === target) {return true}
        if (!(groove instanceof GrooveStackBoxAdapter) || visited.has(groove)) {return false}
        visited.add(groove)
        return groove.members().some(member => GrooveStackBoxAdapter.#reaches(member, target, visited))
    }

    #notify(): void {
        if (this.#notifying) {return}
        this.#notifying = true
        this.#notifier.notify(this)
        this.#notifying = false
    }

    #resubscribeMembers(): void {
        this.#members.terminate()
        this.#entries.adapters().forEach(entry => {
            this.#members.own(entry.box.groove.subscribe(() => {
                this.#resubscribeMembers()
                this.#notify()
            }))
            entry.groove().ifSome(groove => {
                // a member that holds this stack again (merged edits of two peers) is not followed
                if (!GrooveStackBoxAdapter.#reaches(groove, this, new Set())) {
                    this.#members.own(groove.subscribeChange(() => this.#notify()))
                }
            })
        })
    }
}
