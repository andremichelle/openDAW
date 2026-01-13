import {AudioEffectDeviceAdapter, DeviceBoxAdapter, DeviceHost, MidiEffectDeviceAdapter} from "@moises-ai/studio-adapters"
import {DeviceEditorFactory} from "@/ui/devices/DeviceEditorFactory"
import {Exec, Lifecycle, Option, Subscription, Terminable, Terminator, UUID} from "@moises-ai/lib-std"
import {JsxValue} from "@moises-ai/lib-jsx"
import {Box} from "@moises-ai/lib-box"
import {StudioService} from "@/service/StudioService"

type DeviceFactory = (service: StudioService, lifecycle: Lifecycle, box: Box, deviceHost: DeviceHost) => JsxValue

export class DeviceMount implements Terminable {
    static forMidiEffect(service: StudioService,
                         adapter: MidiEffectDeviceAdapter,
                         deviceHost: DeviceHost,
                         invalidateSignal: Exec): DeviceMount {
        return new DeviceMount(service, adapter, deviceHost, DeviceEditorFactory.toMidiEffectDeviceEditor, invalidateSignal)
    }

    static forInstrument(service: StudioService,
                         adapter: DeviceBoxAdapter,
                         deviceHost: DeviceHost,
                         invalidateSignal: Exec): DeviceMount {
        return new DeviceMount(service,
            adapter,
            deviceHost,
            (service, lifecycle, box) => DeviceEditorFactory.toInstrumentDeviceEditor(service, lifecycle, box, deviceHost),
            invalidateSignal)
    }

    static forAudioEffect(service: StudioService,
                          adapter: AudioEffectDeviceAdapter,
                          deviceHost: DeviceHost,
                          invalidateSignal: Exec): DeviceMount {
        return new DeviceMount(service, adapter, deviceHost, DeviceEditorFactory.toAudioEffectDeviceEditor, invalidateSignal)
    }

    readonly #terminator: Terminator = new Terminator()

    readonly #service: StudioService
    readonly #adapter: DeviceBoxAdapter
    readonly #deviceHost: DeviceHost
    readonly #factory: DeviceFactory
    readonly #invalidateSignal: Exec

    readonly #subscription: Subscription

    #optEditor: Option<JsxValue> = Option.None

    private constructor(service: StudioService,
                        adapter: DeviceBoxAdapter,
                        deviceHost: DeviceHost,
                        factory: DeviceFactory,
                        invalidateSignal: Exec) {
        this.#service = service
        this.#adapter = adapter
        this.#deviceHost = deviceHost
        this.#factory = factory
        this.#invalidateSignal = invalidateSignal

        this.#subscription = adapter.minimizedField.subscribe(() => {
            this.#terminator.terminate()
            this.#optEditor = Option.None
            this.#invalidateSignal()
        })
    }

    editor(): JsxValue {
        return this.#optEditor.match({
            none: () => {
                const editor = this.#factory(this.#service, this.#terminator, this.#adapter.box, this.#deviceHost)
                this.#optEditor = Option.wrap(editor)
                return editor
            },
            some: editor => editor
        })
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}

    terminate(): void {
        this.#optEditor = Option.None
        this.#subscription.terminate()
        this.#terminator.terminate()
        this.#invalidateSignal()
    }
}