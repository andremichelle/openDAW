/// <reference types="vite/client" />

declare module "*.sass?inline" {
    const css: string
    export default css
}

interface ImportMetaEnv {
    readonly BUILD_UUID: string
    readonly VITE_ENABLE_MUSCRIPTOR?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}
