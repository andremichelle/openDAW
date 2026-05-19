/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_GOOGLE_CLIENT_ID: string
    readonly VITE_DROPBOX_CLIENT_ID: string
    readonly VITE_VJS_USE_LOCAL_SERVER: string
    readonly VITE_VJS_LOCAL_SERVER_URL: string
    readonly VITE_VJS_ONLINE_SERVER_URL: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}

declare namespace NodeJS {
    interface ProcessEnv {
        readonly VITE_GOOGLE_CLIENT_ID: string
        readonly VITE_DROPBOX_CLIENT_ID: string
        readonly VITE_VJS_USE_LOCAL_SERVER: string
        readonly VITE_VJS_LOCAL_SERVER_URL: string
        readonly VITE_VJS_ONLINE_SERVER_URL: string
    }
}

// `latency` is in the MediaCapture spec but missing from lib.dom MediaTrackSettings.
interface MediaTrackSettings {
    readonly latency?: number
}