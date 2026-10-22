import css from "./GroupRails.sass?inline"
import {AudioUnitBoxAdapter, AudioUnitGroups, ColorCodes} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {Project} from "@opendaw/studio-core"
import {asDefined, Procedure, Terminable, Terminator} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "GroupRails")

export class GroupRails implements Terminable {
    readonly #lifecycle: Terminator
    readonly #rails: Map<AudioUnitBox, {button: HTMLButtonElement, lifecycle: Terminator}>
    constructor(readonly project: Project, readonly container: Element,
                readonly horizontal: boolean, readonly reveal: Procedure<AudioUnitBox>) {
        this.#lifecycle = new Terminator()
        this.#rails = new Map()
        this.#lifecycle.ownAll(
            project.trackSelection.value.subscribe(() => this.#refreshSelection()),
            project.userEditingManager.audioUnit.catchupAndSubscribe(() => this.#refreshSelection())
        )
    }
    update(units: ReadonlyArray<AudioUnitBox>): void {
        const spans = AudioUnitGroups.spans(units)
        const groups = new Set(spans.map(span => span.unit))
        this.#rails.forEach((entry, unit) => {
            if (groups.has(unit)) {return}
            entry.lifecycle.terminate()
            entry.button.remove()
            this.#rails.delete(unit)
        })
        spans.forEach(({unit, start, end, depth}) => {
            if (!this.#rails.has(unit)) {
                const lifecycle = this.#lifecycle.spawn()
                const button = document.createElement("button")
                button.type = "button"
                button.className = `${className} ${this.horizontal ? "horizontal" : "vertical"}`
                const adapter = this.project.boxAdapters.adapterFor(unit, AudioUnitBoxAdapter)
                button.style.setProperty("--color", ColorCodes.forAudioType(adapter.type).toString())
                lifecycle.ownAll(
                    adapter.input.catchupAndSubscribeLabelChange(label => {
                        button.setAttribute("aria-label", `Go to group ${label.unwrapOrElse("Group")}`)
                        button.title = `Go to group ${label.unwrapOrElse("Group")}`
                    }),
                    Events.subscribe(button, "click", () => {
                        this.project.trackSelection.set([unit])
                        this.project.userEditingManager.audioUnit.edit(unit.editing)
                        this.reveal(unit)
                    })
                )
                this.#rails.set(unit, {button, lifecycle})
            }
            const {button} = asDefined(this.#rails.get(unit))
            button.style.setProperty("--rail-depth", String(depth))
            button.style.gridRow = this.horizontal ? "1" : `${start + 1} / ${end + 1}`
            button.style.gridColumn = this.horizontal ? `${start + 2} / ${end + 2}` : "1"
            if (button.parentElement !== this.container) {this.container.appendChild(button)}
        })
        if (this.container instanceof HTMLElement && this.horizontal) {
            this.container.style.setProperty("--group-rail-height", `${spans.length === 0 ? 0 :
                8 + Math.max(...spans.map(span => span.depth)) * 6}px`)
        }
        this.#refreshSelection()
    }
    #refreshSelection(): void {
        this.#rails.forEach(({button}, unit) => button.classList.toggle("selected",
            this.project.trackSelection.isHighlighted(unit)))
    }
    terminate(): void {
        this.#lifecycle.terminate()
        this.#rails.forEach(({button}) => button.remove())
        this.#rails.clear()
    }
}
