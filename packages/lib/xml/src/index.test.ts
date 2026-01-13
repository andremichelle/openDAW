import {describe, expect, it} from "vitest"
import {Xml} from "./index"
import {ComicSchema, LibrarySchema, NovelSchema, TextbookSchema} from "./test.schema"
import {assertInstanceOf} from "@moises-ai/lib-std"

const xml = `
${Xml.Declaration}
<Library name="Central Library" location="Downtown">
  <Sections>
    <Section id="sec1" name="Fiction">
      <Shelf id="shelf1">
        <Novel title="1984" author="George Orwell" pages="328">
          <Review score="9.5">
            <text>Dystopian masterpiece.</text>
          </Review>
        </Novel>
        <Comic title="Watchmen" author="Alan Moore" illustrator="Dave Gibbons">
          <Review score="9.0">
            <text>Iconic and gripping.</text>
          </Review>
        </Comic>
      </Shelf>
    </Section>
    <Section id="sec2" name="Science">
      <Shelf id="shelf2">
        <Textbook title="Physics 101" author="Feynman" edition="2"/>
      </Shelf>
    </Section>
  </Sections>
</Library>
`

describe("Xml.parse() – LibrarySchema", () => {
    it("should parse a complex library with books, reviews and inheritance", () => {
        const library = Xml.parse(xml, LibrarySchema)

        expect(library.name).toBe("Central Library")
        expect(library.location).toBe("Downtown")
        expect(library.sections).toHaveLength(2)

        const fiction = library.sections[0]
        expect(fiction.id).toBe("sec1")
        expect(fiction.name).toBe("Fiction")
        expect(fiction.shelves).toHaveLength(1)

        const shelf1 = fiction.shelves[0]
        expect(shelf1.id).toBe("shelf1")
        expect(shelf1.books).toHaveLength(2)

        const [novel, comic] = shelf1.books
        expect(novel).toBeInstanceOf(NovelSchema)
        assertInstanceOf(novel, NovelSchema)
        expect(novel.title).toBe("1984")
        expect(novel.pages).toBe(328)
        expect(novel.review?.score).toBe(9.5)
        expect(novel.review?.text).toBe("Dystopian masterpiece.")
        expect(comic).toBeInstanceOf(ComicSchema)
        expect(comic.title).toBe("Watchmen")
        assertInstanceOf(comic, ComicSchema)
        expect(comic.illustrator).toBe("Dave Gibbons")
        expect(comic.review?.score).toBe(9.0)
        expect(comic.review?.text).toBe("Iconic and gripping.")
        const science = library.sections[1]
        expect(science.name).toBe("Science")
        const shelf2 = science.shelves[0]
        expect(shelf2.books?.[0]).toBeInstanceOf(TextbookSchema)
        expect((shelf2.books?.[0] as TextbookSchema).edition).toBe(2)
    })
    it("should preserve structure in parse → toElement → serialize", () => {
        const library = Xml.parse(xml, LibrarySchema)
        const recreate = Xml.parse(Xml.pretty(Xml.toElement("Library", library)), LibrarySchema)
        expect(JSON.stringify(library)).toBe(JSON.stringify(recreate)) // not perfect (missing tag names)
    })
})