import {Color, DefaultObservableValue, Lifecycle, RuntimeNotifier} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {Checkbox} from "@/ui/components/Checkbox"
import {WasmEngine} from "@opendaw/studio-core-wasm"
import {Colors} from "@opendaw/studio-enums"

const WasmPurple = new Color(248, 84, 63) // the WebAssembly logo color (#654ff0)

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

// Switches the running project between the TypeScript and the experimental WASM engine. The choice persists
// in localStorage, and every engine boot honors it; flipping reboots the worklet in place (no reload).
export const WasmEngineToggle = ({lifecycle, service}: Construct) => {
    const model = lifecycle.own(new DefaultObservableValue<boolean>(WasmEngine.isEnabled() && WasmEngine.isReady()))
    lifecycle.own(model.subscribe(async owner => {
        const enabled = owner.getValue()
        if (enabled === (WasmEngine.isEnabled() && WasmEngine.isReady())) {return}
        if (enabled && !await WasmEngine.ensureReady(service.audioContext)) {
            model.setValue(false)
            RuntimeNotifier.notify({message: "WASM engine unavailable"})
            return
        }
        WasmEngine.setEnabled(enabled)
        service.restartEngine()
        RuntimeNotifier.notify({message: enabled ? "WASM engine active" : "TypeScript engine active"})
    }))
    return (
        <Checkbox lifecycle={lifecycle}
                  model={model}
                  appearance={{
                      color: Colors.black,
                      activeColor: WasmPurple,
                      tooltip: "Toggle audio-engine",
                      cursor: "pointer"
                  }}>
            <svg viewBox="0 0 128 128" style={{width: "1em", height: "1em"}}>
                <path fill="currentColor"
                      d="M.223.222v127.555h127.555V.222H78.594c.014.227.036.455.036.686 0 8.08-6.55 14.626-14.63 14.626-8.078 0-14.625-6.546-14.625-14.626 0-.231.022-.459.031-.686zm29.595 68.746h8.445l5.782 30.738h.107l6.968-30.738h7.908l6.265 31.119h.106l6.597-31.119h8.284l-10.765 45.156H61.12l-6.213-30.738H54.8l-6.7 30.738h-8.557zm59.994 0h13.334l13.284 45.156h-8.77l-2.879-10.051H89.59l-2.212 10.05h-8.5ZM94.895 80.1l-3.684 16.57h11.473L98.448 80.1Z"/>
            </svg>
        </Checkbox>
    )
}
