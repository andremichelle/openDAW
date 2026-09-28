import {isDefined, Nullable, Option, UUID} from "@opendaw/lib-std"
import {AudioUnitBoxAdapter, RootBoxAdapter} from "@opendaw/studio-adapters"
import {AudioUnitType} from "@opendaw/studio-enums"
import {TracksManager} from "./TracksManager"

type Instrument = { adapter: AudioUnitBoxAdapter, element: HTMLElement }

// Where a NEW instrument unit lands when dropped onto the timeline: a unit index inside the instrument group,
// previewed by a line between the lanes.
export class UnitInsertion {
    readonly #anchor: HTMLElement
    readonly #manager: TracksManager
    readonly #rootBoxAdapter: RootBoxAdapter
    readonly #line: HTMLElement

    constructor(anchor: HTMLElement, manager: TracksManager, rootBoxAdapter: RootBoxAdapter) {
        this.#anchor = anchor
        this.#manager = manager
        this.#rootBoxAdapter = rootBoxAdapter
        this.#line = document.createElement("div")
        this.#line.className = "unit-insert-line"
    }

    // The first instrument unit whose lanes' center lies below the pointer; none means after the last.
    anchorAt(clientY: number): Option<UUID.Bytes> {
        return Option.wrap(this.#below(this.#instruments(), clientY)).map(({adapter}) => adapter.uuid)
    }

    show(clientY: number): void {
        const instruments = this.#instruments()
        if (instruments.length === 0) {
            this.hide()
            return
        }
        const below = this.#below(instruments, clientY)
        const anchorY = isDefined(below)
            ? below.element.getBoundingClientRect().top
            : instruments[instruments.length - 1].element.getBoundingClientRect().bottom
        this.#line.style.top = `${anchorY - this.#anchor.getBoundingClientRect().top - 1}px`
        if (!this.#line.isConnected) {this.#anchor.appendChild(this.#line)}
    }

    hide(): void {
        if (this.#line.isConnected) {this.#line.remove()}
    }

    #below(instruments: ReadonlyArray<Instrument>, clientY: number): Nullable<Instrument> {
        return instruments.find(({element}) => {
            const rect = element.getBoundingClientRect()
            return clientY < (rect.top + rect.bottom) / 2
        }) ?? null
    }

    #instruments(): ReadonlyArray<Instrument> {
        return this.#rootBoxAdapter.audioUnits.adapters()
            .filter(adapter => adapter.type === AudioUnitType.Instrument)
            .flatMap(adapter => this.#manager.unitTracks(adapter.uuid)
                .mapOr(element => element.getClientRects().length > 0 ? [{adapter, element}] : [], []))
            .toSorted((a, b) => a.adapter.indexField.getValue() - b.adapter.indexField.getValue())
    }
}
