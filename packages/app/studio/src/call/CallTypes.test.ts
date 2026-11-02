import {describe, expect, it} from "vitest"
import {asCallPresence, asCallSignal, isTargeted} from "./CallTypes"
import {mungeOpus} from "./CallPeer"

describe("asCallPresence", () => {
    it("rejects values without a peer id", () => {
        expect(asCallPresence(null)).toBeNull()
        expect(asCallPresence(undefined)).toBeNull()
        expect(asCallPresence("peer")).toBeNull()
        expect(asCallPresence({mic: true})).toBeNull()
        expect(asCallPresence({peerId: 42})).toBeNull()
    })
    it("fills missing or malformed fields with safe defaults", () => {
        expect(asCallPresence({peerId: "a", mic: "yes", camera: 1, screenStreamId: 7})).toEqual({
            peerId: "a", mic: false, camera: false, screen: false, hand: false, music: false,
            screenStreamId: "", joinedAt: 0
        })
    })
    it("keeps valid fields", () => {
        const presence = {
            peerId: "a", mic: true, camera: true, screen: true, hand: true, music: true,
            screenStreamId: "s", joinedAt: 123
        }
        expect(asCallPresence(presence)).toEqual(presence)
    })
})

describe("asCallSignal", () => {
    it("parses descriptions and drops unknown description types", () => {
        expect(asCallSignal({
            type: "description", peerId: "a", targetPeerId: "b", description: {type: "offer", sdp: "v=0"}
        })).toEqual({type: "description", peerId: "a", targetPeerId: "b", description: {type: "offer", sdp: "v=0"}})
        expect(asCallSignal({
            type: "description", peerId: "a", targetPeerId: "b", description: {type: "rollback", sdp: ""}
        })).toBeNull()
        expect(asCallSignal({type: "description", peerId: "a", description: {type: "offer", sdp: "v=0"}})).toBeNull()
    })
    it("parses candidates and normalises optional fields", () => {
        expect(asCallSignal({
            type: "candidate", peerId: "a", targetPeerId: "b", candidate: {candidate: "candidate:1", sdpMLineIndex: 0}
        })).toEqual({
            type: "candidate", peerId: "a", targetPeerId: "b",
            candidate: {candidate: "candidate:1", sdpMid: null, sdpMLineIndex: 0, usernameFragment: null}
        })
        expect(asCallSignal({type: "candidate", peerId: "a", targetPeerId: "b", candidate: {}})).toBeNull()
    })
    it("parses bye and rejects unknown types", () => {
        expect(asCallSignal({type: "bye", peerId: "a"})).toEqual({type: "bye", peerId: "a"})
        expect(asCallSignal({type: "hello", peerId: "a"})).toBeNull()
        expect(asCallSignal({type: "bye"})).toBeNull()
    })
})

describe("isTargeted", () => {
    it("only accepts point-to-point signals meant for the local peer", () => {
        const description = {type: "description", peerId: "a", targetPeerId: "b", description: {type: "answer", sdp: ""}} as const
        expect(isTargeted(description, "b")).toBe(true)
        expect(isTargeted(description, "c")).toBe(false)
        expect(isTargeted({type: "bye", peerId: "a"}, "c")).toBe(true)
    })
})

describe("mungeOpus", () => {
    const sdp = [
        "v=0",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
        "a=rtpmap:111 opus/48000/2",
        "a=fmtp:111 minptime=10;useinbandfec=1",
        "a=rtpmap:63 red/48000/2",
        "a=fmtp:63 111/111",
        ""
    ].join("\r\n")
    it("enables stereo and a music bitrate on the opus payload only", () => {
        const result = mungeOpus(sdp)
        expect(result).toContain("a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r\n")
        expect(result).toContain("a=fmtp:63 111/111\r\n")
    })
    it("replaces earlier stereo and bitrate values and is idempotent", () => {
        const once = mungeOpus(sdp.replace("minptime=10", "minptime=10;stereo=0;maxaveragebitrate=20000"))
        expect(once).toContain("a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r\n")
        expect(mungeOpus(once)).toBe(once)
    })
    it("leaves an sdp without opus untouched", () => {
        const video = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n"
        expect(mungeOpus(video)).toBe(video)
    })
})
