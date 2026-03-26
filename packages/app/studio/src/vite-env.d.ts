/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly BUILD_UUID: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}