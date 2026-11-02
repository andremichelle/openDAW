import css from "./SearchField.sass?inline"
import {createElement, replaceChildren, RouteLocation} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {int, isDefined, Lifecycle, Optional} from "@opendaw/lib-std"
import {Icon} from "@opendaw/studio-icons"
import {IconSymbol} from "@opendaw/studio-enums"
import {collectManualPages, ManualPageEntry} from "./Manuals"
import {ManualSearch} from "./ManualSearch"

const className = Html.adoptStyleSheet(css, "SearchField")

let texts: Optional<Promise<ManualSearch.Texts>>

const loadTexts = (): Promise<ManualSearch.Texts> => texts ??= import("virtual:manual-search-texts")
    .then(module => module.default, () => ({}))

export const SearchField = ({lifecycle}: { lifecycle: Lifecycle }) => {
    const pages = collectManualPages()
    const input: HTMLInputElement = <input type="text" placeholder="Search manuals..." spellcheck={false}/>
    const results: HTMLElement = <div className="results hidden"/>
    let found: ReadonlyArray<ManualPageEntry> = []
    let selected: int = 0
    const open = () => results.classList.toggle("hidden", input.value.trim().length === 0)
    const close = () => results.classList.add("hidden")
    const renderSelection = () => {
        Array.from(results.children).forEach((child, index) => child.classList.toggle("selected", index === selected))
        results.children.item(selected)?.scrollIntoView({block: "nearest"})
    }
    const navigate = (page: ManualPageEntry) => {
        input.value = ""
        input.blur()
        close()
        RouteLocation.get().navigateTo(page.path)
    }
    const render = () => {
        const query = input.value
        loadTexts().then(loaded => {
            if (query !== input.value) {return}
            found = ManualSearch.find(pages, loaded, query)
            selected = 0
            replaceChildren(results, found.length === 0
                ? <div className="empty">{`Nothing found for '${query.trim()}'`}</div>
                : found.map((page, index) => (
                    <div className="entry"
                         onpointerenter={() => {
                             selected = index
                             renderSelection()
                         }}
                         onclick={() => navigate(page)}>
                        {isDefined(page.icon) && <Icon symbol={page.icon}/>}
                        <span className="label">{page.label}</span>
                    </div>
                )))
            renderSelection()
            open()
        })
    }
    const moveSelection = (delta: int) => {
        if (found.length === 0) {return}
        selected = (selected + delta + found.length) % found.length
        renderSelection()
    }
    lifecycle.ownAll(
        Events.subscribe(input, "input", render),
        Events.subscribe(input, "focus", open),
        Events.subscribe(input, "blur", close),
        Events.subscribe(results, "pointerdown", (event: PointerEvent) => event.preventDefault()),
        Events.subscribe(input, "keydown", (event: KeyboardEvent) => {
            switch (event.code) {
                case "ArrowDown":
                    event.preventDefault()
                    moveSelection(1)
                    break
                case "ArrowUp":
                    event.preventDefault()
                    moveSelection(-1)
                    break
                case "Enter":
                case "NumpadEnter":
                    event.preventDefault()
                    if (found.length > 0 && !results.classList.contains("hidden")) {navigate(found[selected])}
                    break
                case "Escape":
                    event.preventDefault()
                    input.value = ""
                    close()
                    break
            }
        })
    )
    return (
        <div className={className}>
            <div className="input"><Icon symbol={IconSymbol.Search}/>{input}</div>
            {results}
        </div>
    )
}
