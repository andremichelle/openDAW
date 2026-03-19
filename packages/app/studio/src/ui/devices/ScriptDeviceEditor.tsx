import css from "./ScriptDeviceEditor.sass?inline"
import {DeviceHost, EffectDeviceBoxAdapter, ParameterAdapterSet} from "@opendaw/studio-adapters"
import {asInstanceOf, EmptyExec, Lifecycle, Nullable, Terminable, Terminator, UUID} from "@opendaw/lib-std"
import {Promises} from "@opendaw/lib-runtime"
import {createElement} from "@opendaw/lib-jsx"
import {Field, StringField} from "@opendaw/lib-box"
import {IconSymbol, Pointers} from "@opendaw/studio-enums"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {WerkstattParameterBox} from "@opendaw/studio-boxes"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {Button} from "@/ui/components/Button"
import {Icon} from "@/ui/components/Icon"
import {CodeEditorExample} from "@/ui/werkstatt-editor/CodeEditorState"
import {createScriptCompiler, ScriptCompilerConfig} from "@/ui/werkstatt-editor/ScriptCompiler"

const className = Html.adoptStyleSheet(css, "ScriptDeviceEditor")

type ScriptDeviceBox = {
    readonly code: StringField
    readonly parameters: Field<Pointers.Parameter>
}

type ScriptAdapter = EffectDeviceBoxAdapter & {
    readonly box: ScriptDeviceBox
    readonly parameters: ParameterAdapterSet
}

export type ScriptDeviceEditorConfig = {
    readonly compiler: ScriptCompilerConfig
    readonly defaultCode: string
    readonly examples: ReadonlyArray<CodeEditorExample>
    readonly icon: IconSymbol
    readonly populateMeter: (construct: {
        lifecycle: Lifecycle,
        service: StudioService,
        adapter: ScriptAdapter
    }) => Nullable<HTMLElement>
}

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: ScriptAdapter
    deviceHost: DeviceHost
    config: ScriptDeviceEditorConfig
}

export const ScriptDeviceEditor = ({lifecycle, service, adapter, deviceHost, config}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const compiler = createScriptCompiler(config.compiler)
    const box = adapter.box
    const storedCode = box.code.getValue()
    const userCode = storedCode.length > 0 ? compiler.stripHeader(storedCode) : config.defaultCode
    const compile = async (code: string) => {
        const result = await Promises.tryCatch(compiler.compile(service.audioContext, editing, box, code))
        if (result.status === "resolved") {
            errorIcon.classList.add("hidden")
            errorIcon.title = ""
        } else {
            errorIcon.classList.remove("hidden")
            errorIcon.title = String(result.error)
            throw result.error
        }
    }
    if (storedCode.length > 0) {
        compiler.load(service.audioContext, box).finally(EmptyExec)
    } else {
        compiler.compile(service.audioContext, editing, box, userCode, true).finally(EmptyExec)
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
                        box.code.subscribe(owner => observer(compiler.stripHeader(owner.getValue())))
                },
                initialCode: compiler.stripHeader(box.code.getValue()) || config.defaultCode,
                previousScreen: service.layout.screen.getValue(),
                examples: config.examples
            })
        }
    }
    const controls: HTMLElement = (<div className="controls"/>)
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
    const errorIcon: HTMLElement = (
        <div className="error hidden"><Icon symbol={IconSymbol.Bug}/></div>
    )
    const set = UUID.newSet<{ uuid: UUID.Bytes, lifecycle: Terminable }>(({uuid}) => uuid)
    lifecycle.ownAll(
        service.engine.subscribeDeviceMessage(UUID.toString(adapter.uuid), message => {
            errorIcon.classList.remove("hidden")
            errorIcon.title = message
        }),
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
                controls.appendChild(element)
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
                              {controls}
                              <div className="editor">
                                  {toggleEditorButton}
                                  {errorIcon}
                              </div>
                          </div>
                      )}
                      populateMeter={() => config.populateMeter({lifecycle, service, adapter})}
                      icon={config.icon}/>
    )
}
