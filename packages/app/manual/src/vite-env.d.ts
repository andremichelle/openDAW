/// <reference types="vite/client" />

declare module "*.sass?inline" {
    const css: string
    export default css
}

declare module "virtual:manual-search-texts" {
    const texts: Readonly<Record<string, string>>
    export default texts
}
