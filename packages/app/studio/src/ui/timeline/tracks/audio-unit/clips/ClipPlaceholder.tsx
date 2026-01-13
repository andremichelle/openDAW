import {DefaultObservableValue, isDefined, Lifecycle, Nullable, Terminator} from "@moises-ai/lib-std"
import {createElement, Group, replaceChildren} from "@moises-ai/lib-jsx"
import {AnyClipBoxAdapter} from "@moises-ai/studio-adapters"
import {Clip} from "@/ui/timeline/tracks/audio-unit/clips/Clip.tsx"
import {Project} from "@moises-ai/studio-core"

type Construct = {
    lifecycle: Lifecycle
    project: Project
    adapter: DefaultObservableValue<Nullable<AnyClipBoxAdapter>>
    gridColumn: string
}

export const ClipPlaceholder = ({lifecycle, project, adapter, gridColumn}: Construct) => {
    const element: HTMLElement = <Group/>
    const terminator = lifecycle.own(new Terminator())
    lifecycle.own(
        adapter.catchupAndSubscribe(owner => {
            terminator.terminate()
            const adapter = owner.getValue()
            if (isDefined(adapter)) {
                replaceChildren(element,
                    <Clip lifecycle={terminator}
                          project={project}
                          adapter={adapter}
                          gridColumn={gridColumn}/>
                )
            } else {
                replaceChildren(element,
                    <div className="placeholder" style={{gridColumn}}/>
                )
            }
        }))
    return element
}