/// <reference types="vite/client" />

declare module "*.sass?inline" {
    const css: string
    export default css
}
