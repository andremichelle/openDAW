import css from "./SpielwerkDeviceEditor.sass?inline"
import defaultCode from "./spielwerk-default.txt?raw"
import {DeviceHost, SpielwerkDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {asInstanceOf, EmptyExec, Lifecycle, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {SpielwerkCompiler} from "./SpielwerkCompiler"
import {WerkstattParameterBox} from "@opendaw/studio-boxes"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {IconSymbol} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "SpielwerkDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: SpielwerkDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const SpielwerkDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const box = adapter.box
    const storedCode = box.code.getValue()
    const userCode = storedCode.length > 0 ? SpielwerkCompiler.stripHeader(storedCode) : defaultCode
    const compile = async (code: string) => SpielwerkCompiler.compile(service.audioContext, editing, box, code)
    if (storedCode.length > 0) {
        SpielwerkCompiler.load(service.audioContext, box).finally(EmptyExec)
    } else {
        SpielwerkCompiler.compile(service.audioContext, editing, box, userCode, true).finally(EmptyExec)
    }
    const toggleEditor = () => {
        const isActive = service.activeCodeEditor
            .map(state => UUID.equals(state.handler.uuid, adapter.uuid)).unwrapOrElse(false)
        if (isActive) {
            service.closeCodeEditor()
        } else {
            service.openCodeEditor({
                handler: {
                    uuid: adapter.uuid,
                    name: adapter.labelField,
                    compile,
                    subscribeErrors: observer =>
                        service.engine.subscribeDeviceMessage(UUID.toString(adapter.uuid), observer),
                    subscribeCode: observer =>
                        box.code.subscribe(owner => observer(SpielwerkCompiler.stripHeader(owner.getValue())))
                },
                initialCode: SpielwerkCompiler.stripHeader(box.code.getValue()) || defaultCode,
                previousScreen: service.layout.screen.getValue()
            })
        }
    }
    const knobs: HTMLElement = (<div className="knobs"/>)
    const toggleEditorButton: HTMLElement = (
        <Button lifecycle={lifecycle}
                onClick={toggleEditor}
                appearance={{framed: true, tooltip: "Toggle Code Editor"}}
                style={{
                    fontSize: "16px",
                    height: "min-content",
                    marginTop: "1em"
                }}><Icon symbol={IconSymbol.Code}/></Button>
    )
    const set = UUID.newSet<{ uuid: UUID.Bytes, lifecycle: Terminable }>(({uuid}) => uuid)
    lifecycle.ownAll(
        {
            terminate: () => {
                const isActive = service.activeCodeEditor
                    .map(state => UUID.equals(state.handler.uuid, adapter.uuid)).unwrapOrElse(false)
                if (isActive) {service.closeCodeEditor()}
            }
        },
        service.activeCodeEditor.catchupAndSubscribe(option => {
            const isActive = option.map(state => UUID.equals(state.handler.uuid, adapter.uuid)).unwrapOrElse(false)
            toggleEditorButton.classList.toggle("active", isActive)
        }),
        box.parameters.pointerHub.catchupAndSubscribe({
            onAdded: ({box: paramBox}) => {
                const werkstattParam = asInstanceOf(paramBox, WerkstattParameterBox)
                const parameter = adapter.parameters.parameterAt(werkstattParam.value.address)
                const terminator = new Terminator()
                const element: HTMLElement = ControlBuilder.createKnob({
                    lifecycle: terminator,
                    editing,
                    midiLearning,
                    adapter,
                    parameter
                })
                element.style.order = String(werkstattParam.index.getValue())
                terminator.own(werkstattParam.index.catchupAndSubscribe(owner =>
                    element.style.order = String(owner.getValue())))
                knobs.appendChild(element)
                set.add({uuid: paramBox.address.uuid, lifecycle: terminator})
                terminator.own({terminate: () => element.remove()})
            },
            onRemoved: ({box: {address: {uuid}}}) =>
                set.removeByKey(uuid).lifecycle.terminate()
        })
    )
    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {knobs}
                              {toggleEditorButton}
                          </div>
                      )}
                      populateMeter={() => null}
                      icon={IconSymbol.Code}/>
    )
}
