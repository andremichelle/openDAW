import {defineConfig} from "vitest/config"

export default defineConfig({
    test: {
        globals: true,
        environment: "jsdom"
    },
    esbuild: {
        target: "ESNext"
    }
})
