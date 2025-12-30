# Creating an Audio Effect Device for openDAW

### Disclaimer

Adding a device to openDAW itself requires a PR. There is not yet an open device API hence adding a new device involves
significant manual work. This guide documents how to create a complete audio effect device in openDAW.

## Overview

Creating a device requires these components:

1. **Schema** - Defines the data structure (fields, parameters)
2. **Box** - Auto-generated runtime class from schema
3. **Adapter** - Wraps parameters for automation and UI binding
4. **Processor** - DSP logic that processes audio
5. **Editor** - UI component with controls
6. **Factory registrations** - Makes the device available in the UI

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
cd packages/studio/forge-boxes && npm run build
```

This generates **YourDeviceBox.ts** in `packages/studio/boxes/src/` with typed fields and visitor pattern support.

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

## Step 5: Create the Processor

Location: `packages/studio/core-processors/src/devices/audio-effects/`

Create **YourDeviceProcessor.ts**:

```typescript
import {int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioEffectDeviceAdapter, YourDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer, RenderQuantum} from "@opendaw/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

export class YourDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = YourDeviceProcessor.ID++
    readonly #adapter: YourDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly parameterSomeParam: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None

    constructor(context: EngineContext, adapter: YourDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))

        const {someParam} = adapter.namedParameter
        this.parameterSomeParam = this.own(this.bindParameter(someParam))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#peaks.clear()
        this.#output.clear()
        this.eventInput.clear()
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#output}

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    index(): int {return this.#adapter.indexField.getValue()}
    adapter(): AudioEffectDeviceAdapter {return this.#adapter}

    processAudio(_block: Block, fromIndex: int, toIndex: int): void {
        if (this.#source.isEmpty()) {return}
        const source = this.#source.unwrap()

        // Your DSP processing here
        const srcL = source.getChannel(0)
        const srcR = source.getChannel(1)
        const outL = this.#output.getChannel(0)
        const outR = this.#output.getChannel(1)

        for (let i = fromIndex; i < toIndex; i++) {
            outL[i] = srcL[i]
            outR[i] = srcR[i]
        }

        this.#peaks.process(outL, outR, fromIndex, toIndex)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterSomeParam) {
            // Handle parameter change
        }
    }
}
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

### 7.3 DeviceProcessorFactory

Edit **DeviceProcessorFactory.ts** at `packages/studio/core-processors/src/`:

```typescript
import {YourDeviceBox} from "@opendaw/studio-boxes"
import {YourDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {YourDeviceProcessor} from "./devices/audio-effects/YourDeviceProcessor"

// In AudioEffectDeviceProcessorFactory.create():
visitYourDeviceBox: (box: YourDeviceBox): AudioEffectDeviceProcessor =>
    new YourDeviceProcessor(context, context.boxAdapters.adapterFor(box, YourDeviceBoxAdapter)),
```

### 7.4 DeviceEditorFactory

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

### 7.5 BoxAdapters

Edit **BoxAdapters.ts** at `packages/studio/adapters/src/`:

```typescript
import {YourDeviceBox} from "@opendaw/studio-boxes"
import {YourDeviceBoxAdapter} from "./devices/audio-effects/YourDeviceBoxAdapter"

// In #create():
visitYourDeviceBox: (box: YourDeviceBox) => new YourDeviceBoxAdapter(this.#context, box),
```

## Step 8: Build and Test

```bash
npm run build
```

The device should now appear in the audio effects menu when adding effects to a track.

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

## File Summary

| Component        | Location                                                        |
|------------------|-----------------------------------------------------------------|
| Schema           | `packages/studio/forge-boxes/src/schema/devices/audio-effects/` |
| Box (generated)  | `packages/studio/boxes/src/`                                    |
| Adapter          | `packages/studio/adapters/src/devices/audio-effects/`           |
| Processor        | `packages/studio/core-processors/src/devices/audio-effects/`    |
| Editor           | `packages/app/studio/src/ui/devices/audio-effects/`             |
| EffectFactories  | `packages/studio/core/src/EffectFactories.ts`                   |
| EffectBox        | `packages/studio/core/src/EffectBox.ts`                         |
| ProcessorFactory | `packages/studio/core-processors/src/DeviceProcessorFactory.ts` |
| EditorFactory    | `packages/app/studio/src/ui/devices/DeviceEditorFactory.tsx`    |
| BoxAdapters      | `packages/studio/adapters/src/BoxAdapters.ts`                   |
