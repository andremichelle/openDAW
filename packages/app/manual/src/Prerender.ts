// A crawler gets one HTML file per page with its own head and text, the app replaces the text when it starts
export namespace Prerender {
    export const Origin = "https://opendaw.studio"
    export const DescriptionLimit = 160

    export type Page = { readonly path: string, readonly markdown: string }

    const escape = (text: string): string => text
        .replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

    const plain = (text: string): string => text
        .replace(/!\[[^\]]*]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
        .replace(/[*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim()

    export const titleOf = (markdown: string): string =>
        plain(/^#\s+(.+)$/m.exec(markdown)?.[1] ?? "openDAW Manual")

    export const descriptionOf = (markdown: string): string => {
        const paragraph = markdown.split(/\n\s*\n/)
            .map(block => block.trim())
            .find(block => block.length > 0 && !/^(#|---|!\[|\||```|<)/.test(block)) ?? ""
        const text = plain(paragraph)
        if (text.length <= DescriptionLimit) {return text}
        const cut = text.slice(0, DescriptionLimit - 1)
        return `${cut.slice(0, cut.lastIndexOf(" "))}…`
    }

    export const page = (template: string, {path, markdown}: Page, render: (markdown: string) => string): string => {
        const heading = titleOf(markdown)
        const title = escape(path.length === 0 ? heading : `${heading} · openDAW Manual`)
        const canonical = `${Origin}/manuals/${path}`
        return template
            .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
            .replace(/<meta name="title" content="[^"]*"\/>/, `<meta name="title" content="${title}"/>`)
            .replace(/<meta name="description" content="[^"]*"\/>/,
                `<meta name="description" content="${escape(descriptionOf(markdown))}"/>`)
            .replace("</head>", `    <link rel="canonical" href="${canonical}">\n</head>`)
            .replace(/<body>\s*<\/body>/, `<body><main class="prerender">${render(markdown)}</main></body>`)
    }
}
