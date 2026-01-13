import css from "./Modular.sass?inline"
import {assert, Lifecycle, SortedSet, Terminable, Terminator, UUID} from "@moises-ai/lib-std"
import {createElement} from "@moises-ai/lib-jsx"
import {StudioService} from "@/service/StudioService.ts"
import {ModularBox} from "@moises-ai/studio-boxes"
import {ModularAdapter} from "@moises-ai/studio-adapters"
import {PointerField, Vertex} from "@moises-ai/lib-box"
import {ModularTabButton} from "@/ui/modular/ModularTabButton.tsx"
import {ModularView} from "./ModularView.tsx"
import {EmptyModular} from "@/ui/modular/EmptyModular.tsx"
import {Html} from "@moises-ai/lib-dom"

const className = Html.adoptStyleSheet(css, "Modular")

type ModularTab = {
    uuid: UUID.Bytes
    button: Element
    terminable: Terminable
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const Modular = ({lifecycle, service}: Construct) => {
    const {project} = service
    const boxAdapters = project.boxAdapters
    const navigation: HTMLElement = <nav/>
    const container: HTMLDivElement = <div className="container"/>
    const availableSystems: SortedSet<UUID.Bytes, ModularTab> = UUID.newSet(entry => entry.uuid)
    const addModularSystem = (adapter: ModularAdapter) => {
        const terminator: Terminator = new Terminator()
        const button = <ModularTabButton lifecycle={terminator}
                                         userFocus={project.userEditingManager.modularSystem}
                                         adapter={adapter}/>
        navigation.appendChild(button)
        const added = availableSystems.add({
            uuid: adapter.uuid,
            button: button,
            terminable: terminator
        })
        assert(added, `Could not add tab button for ${adapter}`)
    }
    const removeModularSystem = (uuid: UUID.Bytes) => {
        const tab = availableSystems.removeByKey(uuid)
        tab.button.remove()
        tab.terminable.terminate()
    }

    const pointerHub = project.rootBox.modularSetups.pointerHub
    for (const incomingElement of pointerHub.incoming()) {
        const modularSystemAdapter = boxAdapters.adapterFor(incomingElement.box as ModularBox, ModularAdapter)
        addModularSystem(modularSystemAdapter)
    }
    lifecycle.own(pointerHub.subscribe({
        onAdded: (pointer: PointerField) =>
            addModularSystem(boxAdapters.adapterFor(pointer.box as ModularBox, ModularAdapter)),
        onRemoved: (pointer: PointerField) => removeModularSystem(pointer.address.uuid)
    }))
    const modularViewLifecycle = lifecycle.own(new Terminator())
    lifecycle.own(project.userEditingManager.modularSystem.catchupAndSubscribe(subject => subject.match({
        none: () => {
            modularViewLifecycle.terminate()
            Html.empty(container)
            container.appendChild(<EmptyModular lifecycle={lifecycle}/>)
        },
        some: (vertex: Vertex) => {
            modularViewLifecycle.terminate()
            Html.empty(container)
            const adapter = boxAdapters.adapterFor(vertex.box as ModularBox, ModularAdapter)
            container.appendChild(
                <ModularView lifecycle={modularViewLifecycle}
                             service={service}
                             modularSystemAdapter={adapter}/>
            )
        }
    })))
    return (
        <div className={className}>
            {navigation}
            {container}
        </div>
    )
}