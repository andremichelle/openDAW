import css from "./ModularTabButton.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {ModularAdapter, UserEditing} from "@opendaw/studio-adapters"
import {Vertex} from "@opendaw/lib-box"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "ModularTabButton")

type Construct = {
    lifecycle: Lifecycle
    userFocus: UserEditing
    adapter: ModularAdapter
}

export const ModularTabButton = ({lifecycle, userFocus, adapter}: Construct) => {
    const nameValue = lifecycle.own(Inject.value(adapter.labelField.getValue()))
    lifecycle.own(adapter.labelField.subscribe(owner => nameValue.value = owner.getValue()))
    const element: HTMLDivElement = (
        <div className={className} onclick={() => userFocus.edit(adapter.editingField)}>
            {nameValue}
        </div>
    )
    lifecycle.own(userFocus.catchupAndSubscribe(subject => subject.match({
        none: () => element.classList.remove("focus"),
        some: (vertex: Vertex) => {element.classList.toggle("focus", vertex === adapter.editingField)}
    })))
    return element
}