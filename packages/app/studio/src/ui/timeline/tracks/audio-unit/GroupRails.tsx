import {asDefined, Procedure, Terminable, Terminator} from "@opendaw/lib-std"
import {Events, Html} from "@opendaw/lib-dom"
import {createElement} from "@opendaw/lib-jsx"
import {AudioUnitBoxAdapter, AudioUnitLayout, ColorCodes} from "@opendaw/studio-adapters"
import {AudioUnitBox} from "@opendaw/studio-boxes"
import {Project} from "@opendaw/studio-core"
import css from "./GroupRails.sass?inline"

const className = Html.adoptStyleSheet(css, "GroupRails")

export class GroupRails implements Terminable {
    readonly #lifecycle: Terminator
    readonly #rails: Map<AudioUnitBox, {button: HTMLButtonElement, lifecycle: Terminator}>
    constructor(readonly project: Project, readonly container: Element,
                readonly horizontal: boolean, readonly reveal: Procedure<AudioUnitBox>) {
        this.#lifecycle = new Terminator()
        this.#rails = new Map()
        if (container instanceof HTMLElement) {
            container.style.setProperty("--unit-line-width", `${AudioUnitLayout.RailWidth}px`)
        }
        this.#lifecycle.ownAll(
            project.userEditingManager.audioUnit.catchupAndSubscribe(() => this.#refreshSelection())
        )
    }
    update(spans: ReadonlyArray<AudioUnitLayout.Boundary>): void {
        const groups = new Set(spans.map(span => span.unit))
        this.#rails.forEach((entry, unit) => {
            if (groups.has(unit)) {return}
            entry.lifecycle.terminate()
            entry.button.remove()
            this.#rails.delete(unit)
        })
        spans.forEach(({unit, start, end, indent}) => {
            if (!this.#rails.has(unit)) {
                const lifecycle = this.#lifecycle.spawn()
                const button: HTMLButtonElement = <button type="button" className={`${className} ${this.horizontal ? "horizontal" : "vertical"}`}/>
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
            button.style.setProperty("--rail-offset", `${indent}px`)
            button.style.gridRow = this.horizontal ? "1" : `${start + 1} / ${end + 1}`
            button.style.gridColumn = this.horizontal ? `${start + 2} / ${end + 2}` : "1"
            if (button.parentElement !== this.container) {this.container.appendChild(button)}
        })
        if (this.container instanceof HTMLElement && this.horizontal) {
            // Include one nesting step per rail, accounting for the grid's first control-row gap.
            // The final rail-to-strip gap then matches the gap between nested rails.
            const height = spans.length === 0 ? "0px" :
                `calc(${(1 + Math.max(...spans.map(span => span.depth))) * AudioUnitLayout.Indent}px - var(--mixer-row-gap, 4px))`
            this.container.style.setProperty("--group-rail-height", height)
        }
        this.#refreshSelection()
    }
    #refreshSelection(): void {
        this.#rails.forEach(({button}, unit) => button.classList.toggle("line-active",
            this.project.trackSelection.isLineHighlighted(unit)))
    }
    terminate(): void {
        this.#lifecycle.terminate()
        this.#rails.forEach(({button}) => button.remove())
        this.#rails.clear()
    }
}
