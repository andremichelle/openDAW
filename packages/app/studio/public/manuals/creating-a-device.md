# Creating an Audio Effect Device for openDAW

### Disclaimer

Adding a device to openDAW itself requires a PR. There is not yet an open device API hence adding a new device involves
significant manual work. This guide documents how to create a complete audio effect device in openDAW.

## Overview

The audio engine is written in **Rust** and runs as WebAssembly. Every device's DSP is its own small Rust
crate, compiled to a side module the engine loads at runtime. The TypeScript side owns the data model
(schema/box), the automation value mappings (the adapter is the source of truth), and the UI.

Creating a device requires these components:

1. **Schema** - Defines the data structure (fields, parameters)
2. **Box** - Auto-generated runtime class from schema
3. **Adapter** - Wraps parameters for automation and UI binding
4. **Device crate (Rust)** - DSP logic, compiled to WebAssembly
5. **Editor** - UI component with controls
6. **Factory registrations** - Makes the device available in the UI
7. **Manual** - User-facing documentation for the device

## Step 1: Create the Schema

Location: `packages/studio/forge-boxes/src/schema/devices/audio-effects/`

Create a new file **YourDeviceBox.ts**:

```typescript
import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

export const YourDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("YourDeviceBox", {
    // Non-automatable boolean (no pointerRules)
    10: {type: "boolean", name: "someToggle", value: true},

    // Automatable float parameter
    11: {
        type: "float32", name: "someParam", pointerRules: ParameterPointerRules,
        value: -1.0, constraints: {min: -30.0, max: 0.0, scaling: "linear"}, unit: "dB"
    }
})
```

**Key points:**

- `DeviceFactory.createAudioEffect()` provides standard fields 1-5 (host, index, label, enabled, minimized)
- Custom fields start at 10+
- Use `pointerRules: ParameterPointerRules` for automatable parameters
- Omit `pointerRules` for non-automatable fields
- Constraint types: `"unipolar"`, `"bipolar"`, `"decibel"`, `"linear"`, `"exponential"`, or `{min, max, scaling}`

## Step 2: Export the Schema

Edit **index.ts** at `packages/studio/forge-boxes/src/schema/devices/`:

```typescript
import {YourDeviceBox} from "./audio-effects/YourDeviceBox"

export const DeviceDefinitions = [
    // ... existing devices
    YourDeviceBox,
    // ...
]
```

## Step 3: Generate the Box Class

Run from the forge-boxes directory:

```bash
cd packages/studio/forge-boxes
npm run build
```

This generates **YourDeviceBox.ts** in `packages/studio/boxes/src/` with typed fields and visitor pattern support.

Note: This only generates the TypeScript source files. The full project build (`npm run build` from root) will compile them.

## Step 4: Create the Adapter

Location: `packages/studio/adapters/src/devices/audio-effects/`

Create **YourDeviceBoxAdapter.ts**:

```typescript
import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {YourDeviceBox} from "@opendaw/studio-boxes"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"

export class YourDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"

    readonly #context: BoxAdaptersContext
    readonly #box: YourDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: YourDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): YourDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {this.#parametric.terminate()}

    #wrapParameters(box: YourDeviceBox) {
        return {
            someParam: this.#parametric.createParameter(
                box.someParam,
                ValueMapping.linear(-30.0, 0.0),
                StringMapping.decible, "Some Param")
        } as const
    }
}
```

## Step 5: Create the Rust Device Crate

Location: `crates/stock-devices/`

Create a new crate **device-your-device** (the Cargo workspace picks up `stock-devices/*` automatically):

**Cargo.toml**

```toml
[package]
name = "device-your-device"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib", "lib"]

[dependencies]
abi = {path = "../../abi"}
math = {path = "../../math"}
dsp = {path = "../../dsp"}

[dependencies.libm]
version = "0.2"
```

**src/lib.rs** - implement the SDK's `AudioEffect` template (instruments implement `Instrument`,
MIDI effects `NoteEffect`):

```rust
#![cfg_attr(target_family = "wasm", no_std)]

#[cfg(target_family = "wasm")]
use core::panic::PanicInfo;
use abi::{float_value, AudioEffect, Block, ParamValue, Ports};
use math::value_mapping::Linear;

#[cfg(target_family = "wasm")]
#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    abi::panic_to_host(info)
}

// Field paths = the SCHEMA KEYS of the box ([10] = the field at key 10).
const SOME_PARAM_FIELD: [u16; 1] = [11];
// The device owns its value mappings — they MUST mirror the adapter's `ValueMapping` exactly
// (a parity test enforces this, see Step 8).
const SOME_PARAM_MAPPING: Linear = Linear {min: -30.0, max: 0.0};

/// Per-instance state: engine-allocated and ZEROED — build everything in `init`.
pub struct YourDeviceState {
    some_param: f32,
    some_param_id: u32
}

pub struct YourDevice;

impl AudioEffect for YourDevice {
    type State = YourDeviceState;

    fn init(state: &mut YourDeviceState, _sample_rate: f32) {
        // Automatable parameters bind; non-automatable fields observe (delivered via field_changed).
        state.some_param_id = abi::bind_parameter(&SOME_PARAM_FIELD);
    }

    fn parameter_changed(state: &mut YourDeviceState, id: u32, value: ParamValue) {
        if id == state.some_param_id {
            state.some_param = float_value(value, &SOME_PARAM_MAPPING);
        }
    }

    fn reset(_state: &mut YourDeviceState) {}

    fn process_audio(state: &mut YourDeviceState, output: [&mut [f32]; 2], block: &Block) {
        let Some(input) = abi::resolve_input(abi::MAIN_INPUT) else {return};
        let [in_left, in_right] = input.channels();
        let [out_left, out_right] = output;
        let (s0, s1) = (block.s0 as usize, block.s1 as usize);
        for i in s0..s1 {
            out_left[i] = in_left[i]; // your DSP here
            out_right[i] = in_right[i];
        }
    }
}

// The flat exports the engine loader calls (identical shape for every device).
#[no_mangle]
pub extern "C" fn kind() -> u32 {
    abi::DEVICE_KIND_AUDIO_EFFECT
}

#[no_mangle]
pub extern "C" fn state_size(_sample_rate: f32) -> u32 {
    core::mem::size_of::<YourDeviceState>() as u32
}

#[no_mangle]
pub extern "C" fn process(desc_ptr: u32) {
    let ports = unsafe { Ports::<YourDeviceState>::from_descriptor(desc_ptr) };
    abi::render_effect::<YourDevice>(ports);
}

#[no_mangle]
pub extern "C" fn init(state_ptr: u32, sample_rate: f32) {
    unsafe { abi::with_state(state_ptr, |state| <YourDevice as AudioEffect>::init(state, sample_rate)) }
}

#[no_mangle]
pub extern "C" fn parameter_changed(state_ptr: u32, id: u32, kind: u32, value: f32) {
    unsafe { abi::with_state(state_ptr, |state| <YourDevice as AudioEffect>::parameter_changed(state, id, ParamValue::from_wire(kind, value))) }
}
```

**Key points:**

- The crate is `no_std` on wasm; use `libm` for float math, never `std`.
- The state struct is allocated (zeroed) by the engine — `init` must make it valid; no heap allocation
  during rendering.
- `abi::bind_parameter(&[key])` subscribes an automatable parameter by its schema key path;
  `abi::observe_field(&[key])` subscribes any other field (delivered through `field_changed`).
- The device maps unit automation values to real values itself: the mapping constants MUST match the
  TS adapter's `ValueMapping` (Step 4) — that adapter is the source of truth.
- Look at `crates/stock-devices/device-fold` for a small complete audio effect, `device-gate` for
  sidechain input, and `device-nano` for an instrument.

### 5.1 Register the crate in the build

Edit **build-wasm.sh** at `packages/studio/core-wasm/` and add the crate name to `DEVICE_CRATES`:

```bash
DEVICE_CRATES="... device-your-device"
```

The wasm artifact basename is the crate name with `-` replaced by `_` (`device_your_device.wasm`).

### 5.2 Register the module with the engine loader

Edit **engine-modules.ts** at `packages/studio/core-wasm/src/` and add an entry mapping the box type to
the wasm module:

```typescript
{url: "/wasm/plugins/device_your_device.wasm", boxType: "YourDeviceBox"}, // audio effect
```

## Step 6: Create the Editor UI

Location: `packages/app/studio/src/ui/devices/audio-effects/`

Create **YourDeviceEditor.sass**:

```sass
@use "@/mixins"

component
  display: flex
  flex-direction: row
  align-items: center
  gap: 1em
  padding: 0.5em
  @include mixins.Control
```

Create **YourDeviceEditor.tsx**:

```tsx
import css from "./YourDeviceEditor.sass?inline"
import {YourDeviceBoxAdapter, DeviceHost} from "@opendaw/studio-adapters"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {DeviceEditor} from "@/ui/devices/DeviceEditor.tsx"
import {MenuItems} from "@/ui/devices/menu-items.ts"
import {DevicePeakMeter} from "@/ui/devices/panel/DevicePeakMeter.tsx"
import {Html} from "@opendaw/lib-dom"
import {StudioService} from "@/service/StudioService"
import {EffectFactories} from "@opendaw/studio-core"
import {ControlBuilder} from "@/ui/devices/ControlBuilder"
import {Checkbox} from "@/ui/components/Checkbox"
import {EditWrapper} from "@/ui/wrapper/EditWrapper"
import {Colors} from "@opendaw/studio-enums"

const className = Html.adoptStyleSheet(css, "YourDeviceEditor")

type Construct = {
    lifecycle: Lifecycle
    service: StudioService
    adapter: YourDeviceBoxAdapter
    deviceHost: DeviceHost
}

export const YourDeviceEditor = ({lifecycle, service, adapter, deviceHost}: Construct) => {
    const {project} = service
    const {editing, midiLearning} = project
    const {someParam} = adapter.namedParameter

    return (
        <DeviceEditor lifecycle={lifecycle}
                      project={project}
                      adapter={adapter}
                      populateMenu={parent => MenuItems.forEffectDevice(parent, service, deviceHost, adapter)}
                      populateControls={() => (
                          <div className={className}>
                              {/* Knob for automatable parameter */}
                              {ControlBuilder.createKnob({
                                  lifecycle, editing, midiLearning, adapter,
                                  parameter: someParam
                              })}

                              {/* Checkbox for non-automatable boolean */}
                              <Checkbox lifecycle={lifecycle}
                                        model={EditWrapper.forValue(editing, adapter.box.someToggle)}
                                        appearance={{
                                            color: Colors.cream,
                                            activeColor: Colors.orange,
                                            framed: true,
                                            cursor: "pointer"
                                        }}>Toggle</Checkbox>
                          </div>
                      )}
                      populateMeter={() => (
                          <DevicePeakMeter lifecycle={lifecycle}
                                           receiver={project.liveStreamReceiver}
                                           address={adapter.address}/>
                      )}
                      icon={EffectFactories.AudioNamed.YourDevice.defaultIcon}/>
    )
}
```

## Step 7: Register in Factories

### 7.1 EffectFactories

Edit **EffectFactories.ts** at `packages/studio/core/src/`:

```typescript
import {YourDeviceBox} from "@opendaw/studio-boxes"

// Add factory definition
export const YourDevice: EffectFactory = {
    defaultName: "Your Device",
    defaultIcon: IconSymbol.Peak,  // Choose appropriate icon
    description: "Description of your device",
    separatorBefore: false,
    type: "audio",
    create: ({boxGraph}, hostField, index): YourDeviceBox =>
        YourDeviceBox.create(boxGraph, UUID.generate(), box => {
            box.label.setValue("Your Device")
            box.index.setValue(index)
            box.host.refer(hostField)
        })
}

// Add to AudioNamed
export const AudioNamed = {
    StereoTool, YourDevice, Compressor, /* ... */
}
```

### 7.2 EffectBox Type

Edit **EffectBox.ts** at `packages/studio/core/src/`:

```typescript
import {YourDeviceBox} from "@opendaw/studio-boxes"

export type EffectBox =
    | /* existing */ | YourDeviceBox
```

### 7.3 DeviceEditorFactory

Edit **DeviceEditorFactory.tsx** at `packages/app/studio/src/ui/devices/`:

```typescript
import {YourDeviceBox} from "@opendaw/studio-boxes"
import {YourDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {YourDeviceEditor} from "@/ui/devices/audio-effects/YourDeviceEditor"

// In toAudioEffectDeviceEditor():
visitYourDeviceBox: (box: YourDeviceBox) => (
    <YourDeviceEditor lifecycle = {lifecycle}
service = {service}
adapter = {service.project.boxAdapters.adapterFor(box, YourDeviceBoxAdapter)}
deviceHost = {deviceHost}
/>
),
```

### 7.4 BoxAdapters

Edit **BoxAdapters.ts** at `packages/studio/adapters/src/`:

```typescript
import {YourDeviceBox} from "@opendaw/studio-boxes"
import {YourDeviceBoxAdapter} from "./devices/audio-effects/YourDeviceBoxAdapter"

// In #create():
visitYourDeviceBox: (box: YourDeviceBox) => new YourDeviceBoxAdapter(this.#context, box),
```

## Step 8: Build and Test

```bash
npm run build        # TypeScript packages
npm run build-wasm   # the engine + all device crates (needs the Rust toolchain + binaryen)
```

The device should now appear in the audio effects menu when adding effects to a track. Hard-reload the
studio after `build-wasm` so the browser drops the cached wasm.

**Parity test:** add your device to `packages/app/wasm/test/param-mapping-parity.test.ts` — it loads the
wasm standalone and asserts every bound parameter's value mapping matches the TS adapter's. Run with:

```bash
cd packages/app/wasm && npx vitest run test/param-mapping-parity.test.ts
```

## Common Patterns

### Automatable vs Non-Automatable

- **Automatable**: Use `pointerRules: ParameterPointerRules` in schema, wrap with `#parametric.createParameter()` in
  adapter
- **Non-automatable**: Omit `pointerRules` in schema, access directly via `adapter.box.fieldName`

### UI Controls

- **Knobs**: `ControlBuilder.createKnob({...})`
- **Toggle buttons for automatable booleans**: `ParameterToggleButton`
- **Checkboxes for non-automatable booleans**: `Checkbox` with `EditWrapper.forValue()`

### Subscribing to Non-Automatable Changes

```typescript
adapter.box.someField.catchupAndSubscribe(() => {
    // React to field changes
})
```

## Step 9: Create the Device Manual

Each device should have a user-facing manual that documents its purpose and parameters.

### 9.1 Create the Manual File

Location: `packages/app/studio/public/manuals/devices/<category>/`

Categories:
- `midi/` - MIDI effect devices
- `audio/` - Audio effect devices
- `instruments/` - Instrument devices

Create **your-device.md** (use kebab-case):

```markdown
# Your Device

Brief description of what the device does.

## Parameters

### Some Param
Controls the intensity of the effect. Range: -30dB to 0dB.

### Some Toggle
Enables or disables a feature.

## Tips

- Usage tip 1
- Usage tip 2
```

### 9.2 Register the Manual URL

Edit **DeviceManualUrls.ts** at `packages/studio/adapters/src/`:

```typescript
export namespace DeviceManualUrls {
    // Audio Effects
    export const YourDevice = "manuals/devices/audio/your-device"
    // ...
}
```

### 9.3 Link in EffectFactories

The manual URL is referenced in the factory definition. Edit **EffectFactories.ts**:

```typescript
import {DeviceManualUrls} from "@opendaw/studio-adapters"

export const YourDevice: EffectFactory = {
    defaultName: "Your Device",
    defaultIcon: IconSymbol.Peak,
    description: "Description of your device",
    manualUrl: DeviceManualUrls.YourDevice,  // Add this line
    // ...
}
```

This makes the manual accessible via the device's context menu in the UI.

## File Summary

| Component           | Location                                                        |
|---------------------|-----------------------------------------------------------------|
| Schema              | `packages/studio/forge-boxes/src/schema/devices/audio-effects/` |
| Box (generated)     | `packages/studio/boxes/src/`                                    |
| Adapter             | `packages/studio/adapters/src/devices/audio-effects/`           |
| Device crate (Rust) | `crates/stock-devices/device-your-device/`                      |
| Build registration  | `packages/studio/core-wasm/build-wasm.sh` (`DEVICE_CRATES`)     |
| Module registration | `packages/studio/core-wasm/src/engine-modules.ts`               |
| Editor              | `packages/app/studio/src/ui/devices/audio-effects/`             |
| EffectFactories     | `packages/studio/core/src/EffectFactories.ts`                   |
| EffectBox           | `packages/studio/core/src/EffectBox.ts`                         |
| EditorFactory       | `packages/app/studio/src/ui/devices/DeviceEditorFactory.tsx`    |
| BoxAdapters         | `packages/studio/adapters/src/BoxAdapters.ts`                   |
| Parity test         | `packages/app/wasm/test/param-mapping-parity.test.ts`           |
| Manual              | `packages/app/studio/public/manuals/devices/<category>/`        |
| ManualUrls          | `packages/studio/adapters/src/DeviceManualUrls.ts`              |
