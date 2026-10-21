# Optional MuScriptor feature

MuScriptor is **disabled by default**. Its weights have separate **CC BY-NC 4.0
(non-commercial)** terms. Enabling it is an explicit choice by the application builder.
The switch does not change openDAW's license or the terms of any other dependency.

## Build

From the repository root, after the normal Node/Rust setup:

```sh
# Exclude MuScriptor (also the default when the variable is unset).
VITE_ENABLE_MUSCRIPTOR=false npx turbo run build --filter=@opendaw/app-studio
node packages/app/studio/scripts/check-muscriptor-build.mjs disabled

# Explicitly include the optional feature.
VITE_ENABLE_MUSCRIPTOR=true npx turbo run build --filter=@opendaw/app-studio
node packages/app/studio/scripts/check-muscriptor-build.mjs enabled
```

Only the literal `true` enables it. The variable can also be set in Studio's local
Vite environment file. Turborepo includes it in the Studio build cache key, so enabled
and disabled outputs do not share a cache entry. It applies to development builds too.

Disabled builds hide the dashboard, Import menu and both clip-context actions. A
build-time alias also removes the implementation from the module graph: no MuScriptor
worker, model download URLs or model metadata are emitted, including in source maps.
The audit above checks the actual output instead of relying only on hidden controls.

## SDK boundary

The SDK and `studio-core` have no MuScriptor dependencies, exports or changes in this
contribution. Clip timing and MIDI insertion helpers live inside the Studio app.
The shared `@opendaw/lib-inference` entry point does not export the model integration.
It is available only through the optional `@opendaw/lib-inference/muscriptor` subpath.
No model weights are bundled or published by this repository.

## Download consent

Before creating a source track or starting inference, the app probes model-cache
metadata. If files are missing, it shows their remaining size in decimal MB, the full
model size (616.3 MB), the download source and the non-commercial weight terms.
**Cancel** or Escape stops the request without importing audio or downloading weights.
**Download & Continue** permits the download and conversion.

A complete cache skips this prompt. Cache-only execution forbids network fallback:
if another tab removes those files, conversion stops and the next attempt asks again.
Clearing browser data, switching browser/origin, or changing the pinned model revision
can require a new download and confirmation. Other inference features keep their
existing behavior.
