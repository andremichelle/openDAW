import {describe, expect, it} from "vitest"
import {Prerender} from "./Prerender"

const template = `<!doctype html>
<html lang="en">
<head>
    <meta name="title" content="openDAW Manuals"/>
    <meta name="description" content="openDAW user manuals. Read device and studio documentation."/>
    <title>openDAW Manuals</title>
    <script type="module" src="/manuals/assets/index-AbCdEfGh.js"></script>
</head>
<body></body>
</html>`

const markdown = `# Automation Editing

The automation editor allows you to create and edit parameter **automation** curves. Each lane shows
[events](/manuals/mixer) connected by curves.

---

![screenshot](automation.webp)

## Overview
`

const render = (text: string): string => `<p>${text.length}</p>`

describe("Prerender", () => {
    it("gives every page its own title, description and canonical url", () => {
        const html = Prerender.page(template, {path: "automation", markdown}, render)
        expect(html).toContain("<title>Automation Editing · openDAW Manual</title>")
        expect(html).toContain(`<meta name="title" content="Automation Editing · openDAW Manual"/>`)
        expect(html).toContain(`<meta name="description" content="The automation editor allows you to create and edit parameter automation curves. Each lane shows events connected by curves."/>`)
        expect(html).toContain(`<link rel="canonical" href="https://opendaw.studio/manuals/automation">`)
        expect(html.match(/rel="canonical"/g)).toHaveLength(1)
    })

    it("puts the rendered page into the body, where the app replaces it when it starts", () => {
        const html = Prerender.page(template, {path: "automation", markdown}, render)
        expect(html).toContain(`<body><main class="prerender"><p>${markdown.length}</p></main></body>`)
        expect(html).toContain(`<script type="module" src="/manuals/assets/index-AbCdEfGh.js"></script>`)
    })

    it("uses the manuals root as canonical for the index page and keeps its title", () => {
        const html = Prerender.page(template, {path: "", markdown: "# openDAW Manuals\n\nopenDAW runs in your browser."}, render)
        expect(html).toContain(`<link rel="canonical" href="https://opendaw.studio/manuals/">`)
        expect(html).toContain("<title>openDAW Manuals</title>")
    })

    it("escapes quotes and angle brackets in head values and cuts long descriptions at a word", () => {
        const long = `# A "B" <C>\n\n${"word ".repeat(80)}`
        const html = Prerender.page(template, {path: "x", markdown: long}, render)
        expect(html).toContain("<title>A &quot;B&quot; &lt;C&gt; · openDAW Manual</title>")
        const description = /name="description" content="([^"]*)"/.exec(html)?.[1] ?? ""
        expect(description.length).toBeLessThanOrEqual(160)
        expect(description.endsWith("…")).toBe(true)
        expect(description).not.toContain("wor…")
    })

    it("maps device pages to their nested path", () => {
        const html = Prerender.page(template, {path: "devices/audio/delay", markdown: "# Delay\n\nA stereo delay."}, render)
        expect(html).toContain(`<link rel="canonical" href="https://opendaw.studio/manuals/devices/audio/delay">`)
    })
})
