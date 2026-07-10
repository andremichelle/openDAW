import {DefaultObservableValue, Lifecycle, RuntimeNotifier} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {StudioService} from "@/service/StudioService"
import {Checkbox} from "@/ui/components/Checkbox"
import {Icon} from "@/ui/components/Icon"
import {WasmEngine} from "@opendaw/studio-core-wasm"
import {Colors, IconSymbol} from "@opendaw/studio-enums"

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
                      activeColor: Colors.bright,
                      tooltip: "Toggle audio-engine",
                      cursor: "pointer"
                  }}>
            <span style={{color: Colors.shadow.toString()}}>WebAssembly Engine</span>
            <hr/>
            <Icon symbol={IconSymbol.Checkbox}/>
        </Checkbox>
    )
}
