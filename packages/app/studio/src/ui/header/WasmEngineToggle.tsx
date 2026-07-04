import {DefaultObservableValue, Lifecycle, RuntimeNotifier} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Colors} from "@opendaw/studio-enums"
import {StudioService} from "@/service/StudioService"
import {Checkbox} from "@/ui/components/Checkbox"
import {WasmEngine} from "@/wasm-engine/WasmEngine"

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
}

// Switches the running project between the TypeScript and the experimental WASM engine. The choice persists
// in localStorage and every engine boot honors it; flipping reboots the worklet in place (no reload).
export const WasmEngineToggle = ({lifecycle, service}: Construct) => {
    const model = new DefaultObservableValue<boolean>(WasmEngine.isEnabled())
    lifecycle.own(model.subscribe(async owner => {
        const enabled = owner.getValue()
        if (enabled === WasmEngine.isEnabled()) {return}
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
                      activeColor: Colors.orange,
                      tooltip: "Experimental WASM engine (reboots the audio engine)",
                      cursor: "pointer"
                  }}>
            <h5>WASM</h5>
        </Checkbox>
    )
}
