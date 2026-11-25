import {Objects} from "@opendaw/lib-std"
import {ShortcutDefinitions} from "@opendaw/lib-dom"

// a printable page of the given shortcut mapping, opened in a new tab
export namespace ShortcutSheet {
    const escape = (text: string): string => text
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

    const titleOf = (context: string): string => context.split("-")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")

    export const render = (contexts: Readonly<Record<string, ShortcutDefinitions>>): string => {
        const sections = Objects.entries(contexts).map(([context, definitions]) => `
<section>
    <h2>${escape(titleOf(context))}</h2>
    <table>
        <tbody>${Objects.entries(definitions).map(([, {description, shortcut}]) => `
            <tr><td>${escape(description)}</td><td>${shortcut.format().map(key => `<kbd>${escape(key)}</kbd>`).join("")}</td></tr>`).join("")}
        </tbody>
    </table>
</section>`).join("")
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>openDAW Shortcuts</title>
<style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 2.5rem; background: white; color: black;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1.5rem; }
    h1 { margin: 0; font-size: 1.5rem; font-weight: 600; }
    header span { color: #666; }
    button { font: inherit; padding: 0.375rem 1rem; border: 1px solid black; border-radius: 0.375rem;
        background: white; color: black; cursor: pointer; }
    main { columns: 2 22rem; column-gap: 2.5rem; }
    section { margin-bottom: 1.75rem; }
    tr { break-inside: avoid; }
    h2 { break-after: avoid; margin: 0 0 0.375rem; font-size: 0.8125rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 0.25rem 0; border-top: 1px solid #ddd; vertical-align: top; }
    td:last-child { text-align: right; white-space: nowrap; padding-left: 1rem; }
    kbd { display: inline-block; min-width: 1.5em; margin-left: 0.125rem; padding: 0 0.3em; border: 1px solid #bbb;
        border-radius: 0.25rem; font: inherit; font-size: 0.75rem; text-align: center; }
    @page { margin: 1.5cm; }
    @media print {
        body { padding: 0; }
        button { display: none; }
        main { columns: 2; column-gap: 1.5cm; }
    }
</style>
</head>
<body>
<header>
    <h1>openDAW Shortcuts</h1>
    <span>${escape(new Date().toLocaleDateString())} <button onclick="window.print()">Print</button></span>
</header>
<main>${sections}
</main>
</body>
</html>`
    }

    export const open = (contexts: Readonly<Record<string, ShortcutDefinitions>>): void => {
        const url = URL.createObjectURL(new Blob([render(contexts)], {type: "text/html"}))
        window.open(url, "_blank")
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
    }
}
