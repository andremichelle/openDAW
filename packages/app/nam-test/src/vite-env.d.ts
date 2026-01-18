/// <reference types="vite/client" />

// TODO Remove
declare module "@andremichelle/nam-wasm/nam.js" {
    import {EmscriptenModule} from "@andremichelle/nam-wasm"

    interface ModuleOptions {
        wasmBinary?: ArrayBuffer
        locateFile?: (path: string, scriptDirectory: string) => string
    }

    function createNamModule(options?: ModuleOptions): Promise<EmscriptenModule>
    export default createNamModule
}
