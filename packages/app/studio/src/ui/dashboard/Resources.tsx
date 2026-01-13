import css from "./Resources.sass?inline"
import {Html} from "@moises-ai/lib-dom"
import {DefaultObservableValue, Lifecycle, Terminator} from "@moises-ai/lib-std"
import {createElement, replaceChildren} from "@moises-ai/lib-jsx"
import {ProjectBrowser} from "@/project/ProjectBrowser"
import {Dialogs} from "@/ui/components/dialogs"
import {SampleBrowser} from "@/ui/browse/SampleBrowser"
import {SoundfontBrowser} from "@/ui/browse/SoundfontBrowser"
import {StudioService} from "@/service/StudioService"
import {RadioGroup} from "@/ui/components/RadioGroup"
import {Colors} from "@moises-ai/studio-enums"

const className = Html.adoptStyleSheet(css, "Resources")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

export const Resources = ({lifecycle, service}: Construct) => {
    const scope = new DefaultObservableValue(0)
    return (
        <div className={className}>
            <RadioGroup lifecycle={lifecycle}
                        style={{columnGap: "1em"}}
                        appearance={{activeColor: Colors.orange}}
                        model={scope}
                        elements={[
                            {value: 0, element: (<h3>Projects</h3>)},
                            {value: 1, element: (<h3>Samples</h3>)},
                            {value: 2, element: (<h3>Soundfonts</h3>)}
                        ]}/>
            <div style={{display: "contents"}} onInit={element => {
                const scopeLifeCycle = lifecycle.own(new Terminator())
                lifecycle.own(scope.catchupAndSubscribe(owner => {
                    replaceChildren(element)
                    scopeLifeCycle.terminate()
                    switch (owner.getValue()) {
                        case 0:
                            replaceChildren(element, (
                                <ProjectBrowser service={service}
                                                lifecycle={scopeLifeCycle}
                                                select={async ([uuid, meta]) => {
                                                    const handler = Dialogs.processMonolog("Loading...")
                                                    await service.projectProfileService.load(uuid, meta)
                                                    handler.close()
                                                }}/>
                            ))
                            break
                        case 1:
                            replaceChildren(element, (
                                <SampleBrowser lifecycle={scopeLifeCycle} service={service}/>
                            ))
                            break
                        case 2:
                            replaceChildren(element, (
                                <SoundfontBrowser lifecycle={scopeLifeCycle} service={service}/>
                            ))
                            break
                    }
                }))
            }}>
            </div>
        </div>
    )
}