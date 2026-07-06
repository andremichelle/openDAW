# openDAW SDK

`npm install @opendaw/studio-sdk`

* `@opendaw/lib-std`
* `@opendaw/lib-dom`
* `@opendaw/lib-jsx`
* `@opendaw/lib-box`
* `@opendaw/lib-dsp`
* `@opendaw/lib-xml`
* `@opendaw/lib-midi`
* `@opendaw/lib-runtime`
* `@opendaw/lib-fusion`
* `@opendaw/lib-dawproject`
* `@opendaw/studio-enums`
* `@opendaw/studio-boxes`
* `@opendaw/studio-adapters`
* `@opendaw/studio-core`
* `@opendaw/studio-core-wasm`

## WASM engine

`@opendaw/studio-core-wasm` ships the Rust audio engine as prebuilt artifacts: the realtime worklet module
(`dist/wasm-processor.js`), the offline render worker (`dist/wasm-offline-worker.js`) and the binaries
(`dist/wasm/engine.wasm`, `dist/wasm/plugins/*.wasm`). Serve the package's `dist/` from your host (the page
must be cross-origin isolated — COOP/COEP — for the SharedArrayBuffer the engine memory needs) and install
it before booting:

```ts
import {WasmEngine} from "@opendaw/studio-core-wasm"

WasmEngine.install({
    processorUrl: "/opendaw-wasm/wasm-processor.js",
    offlineWorkerUrl: "/opendaw-wasm/wasm-offline-worker.js",
    wasmUrl: "/opendaw-wasm"
})
if (WasmEngine.isEnabled() && !await WasmEngine.ensureReady(audioContext)) {
    console.warn("WASM engine unavailable — TypeScript engine active")
}
```

With a bundler that resolves package assets (e.g. vite), the two module URLs can come straight from the
package: `import wasmProcessorUrl from "@opendaw/studio-core-wasm/wasm-processor.js?url"`. The engine is
enabled by default; `WasmEngine.setEnabled(false)` persists an opt-out to the TypeScript engine. Offline
renders (mixdown, stems, freeze) follow automatically via `OfflineEngineRenderer`.

## Dual-Licensing Model

openDAW is available **under two alternative license terms**:

| Option                    | When to choose it                                                                                                    | Obligations                                                                                                                                                                                                                                                       |
|---------------------------|----------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **A. AGPL v3 (or later)** | You are happy for the entire work that includes openDAW to be released under AGPL-compatible open-source terms.      | – Must distribute complete corresponding source code under AGPL.<br>– Must keep copyright & licence notices.<br>– Applies both to distribution **and** to public use via network/SaaS (§13).<br>– May run openDAW privately in any software, open or closed (§0). |
| **B. Commercial Licence** | You wish to incorporate openDAW into **closed-source** or otherwise licence-incompatible software or SaaS offerings. | – Pay the agreed fee.<br>– No copyleft requirement for your own source code.<br>– Other terms as per the signed agreement.                                                                                                                                        |

> **How to obtain the Commercial License**  
> Email `andre.michelle@opendaw.org` with your company name, product description, and expected distribution volume.

If you redistribute or run modified versions of openDAW for public use **without** a commercial license, the AGPL v3
terms apply automatically.

## Components excluded from the Commercial License

The components below ship with openDAW but are **not** covered by Option B (Commercial License). Their upstream
licenses are copyleft, or they depend on a third-party service whose terms cannot be sublicensed by openDAW. A
commercial-license build must omit or replace each of them.

| Component                       | Location                                                                                              | Upstream                                                                              | Why excluded                                                                                                              |
|---------------------------------|-------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| **Compressor**                  | `lib/dsp/src/ctagdrc/`<br>`studio/core-processors/.../CompressorDeviceProcessor.ts`                   | CTAGDRC (Phillip Lamp, 2020) + LookAhead by Daniel Rudrich, 2019 — **GPL v3.0**       | Upstream GPL cannot be sublicensed under non-copyleft terms. Replace with a permissively-licensed compressor for option B. |
| **Neural Amp / Tone3000**       | `app/studio/.../NeuralAmp/NamTone3000.*`<br>`Tone3000Dialog.tsx`<br>icons + manual references         | tone3000.com — third-party service and per-model licensing                            | Integration calls the Tone3000 API and loads models whose individual licenses are set by their authors on tone3000.com.    |
| **AI Tempo Detection**          | `lib/inference/src/tasks/TempoDetectionTask.ts`<br>`assets.opendaw.studio/models/tempo-cnn/`          | TempoCNN (Schreiber & Müller, hendriks73/tempo-cnn) — **AGPL v3.0**                   | Upstream AGPL cannot be sublicensed. The `lib-inference` package itself is not part of the SDK either.                     |

`lib-inference` (the rest of it — stem separation, audio-to-MIDI) and the assets it pulls from
`assets.opendaw.studio` are runtime-only and **not** part of the SDK distribution; they are listed here only because
they ship inside the open-source studio.

## License

[AGPL v3 (or later)](https://www.gnu.org/licenses/agpl-3.0.txt) © 2025 André Michelle