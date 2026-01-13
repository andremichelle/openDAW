import {describe, expect, it} from "vitest"
import {asInstanceOf} from "@moises-ai/lib-std"
import {Xml} from "@moises-ai/lib-xml"
import {MetaDataSchema, ProjectSchema, TrackSchema} from "./"
import exampleXml from "@test-files/bitwig.example.xml?raw"

describe("DAW-project XML", () => {
    it("MetaData", () => {
        const title = "This is the title."
        const artist = "André Michelle"
        const website = "https://opendaw.studio"
        const xmlString = Xml.pretty(Xml.toElement("MetaData",
            Xml.element({title, artist, website}, MetaDataSchema)))
        const metaDataSchema = Xml.parse(xmlString, MetaDataSchema)
        expect(metaDataSchema.title).toBe(title)
        expect(metaDataSchema.artist).toBe(artist)
        expect(metaDataSchema.website).toBe(website)
        expect(metaDataSchema.comment).toBe(undefined)
    })
    it("random tests", () => {
        const result: ProjectSchema = Xml.parse(exampleXml, ProjectSchema)
        expect(asInstanceOf(result.structure[0], TrackSchema).channel?.audioChannels).toBe(2)
        expect(asInstanceOf(result.structure[1], TrackSchema).channel?.id).toBe("id10")
    })
})