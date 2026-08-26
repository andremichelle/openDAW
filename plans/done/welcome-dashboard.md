# Welcome Dashboard Redesign

The screen shown after the app boots (`ui/dashboard/Dashboard.tsx`, the "dashboard" workspace screen). Not to be
confused with the statistics dashboard at `/stats` (see `plans/dashboard.md`).

Goals: welcome new users and power users, give the lists more room, make the primary actions prominent, and surface
the value proposition and community.

Hard constraint: this is a **one-pager**. Nothing scrolls except the list area inside the right column (D). The left
rail (C) must pack everything into the viewport height without its own scrollbar, so keep its tiles compact.

Icons: use `IconSymbol` from the library (no emoji). Add new symbols only where none fit (e.g. GitHub / Discord /
Instagram / LinkedIn brand marks are not in the library yet — text links for now, brand icons to add later).
Framing: subtle, like `/stats` cards, but low-key.

## Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  openDAW                                                                        │  A. hero: brand + claim
│  Create music online                                                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐                    │  B. intro tiles (one row, 5)
│ │🎛 Web DAW││👥 Live   ││🎓 Learn  ││🔒 Private││⬡ Open src│                    │
│ │ devices +││ real-time││ by doing ││ no acct, ││ you own  │                    │
│ │ recording││ collab   ││ education││ your data││ it,extend│                    │
│ └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘                    │
├─────────────────────────────────┬──────────────────────────────────────────────┤
│ ┌───────────────────────────┐   │ [Projects][Templates][Demos][Samples][Sound…]│  D. tab group over the
│ │ ▶ NEW PROJECT   clean     │   │ ┌──────────────────────────────────────────┐ │     wide list column
│ ├───────────────────────────┤   │ │                                          │ │
│ │ ◆ NEW LIVE ROOM  jam      │   │ │  the list fills the right column         │ │
│ ├───────────────────────────┤   │ │                                          │ │
│ │ ⤓ Open bundle (.odb)      │   │ │  Projects empty →                        │ │
│ └───────────────────────────┘   │ │   "start with a demo project" → (Demos)  │ │
│ Backup & Sync                   │ │                                          │ │
│  [◇ Dropbox][▲ Drive][☁ Nextc.] │ │                                          │ │
│ Sponsors ♥                      │ │                                          │ │
│  ◍◍◍◍◍◍◍◍◍◍  (up to 20)        │ │                                          │ │
│ Help & Feedback                 │ │                                          │ │
│  Preferences · Manuals          │ │                                          │ │
│  Report a bug · Request feature │ │                                          │ │
│ Links                           │ │                                          │ │
│  opendaw.org GitHub Discord     │ │                                          │ │
│  Instagram LinkedIn             │ └──────────────────────────────────────────┘ │
└─────────────────────────────────┴──────────────────────────────────────────────┘
   C. left rail (scrolls if tall)            D. right column (lists get the room)
```

## Regions and tiles

Going over each:

### A. Hero

1. Brand `openDAW` + claim "Create music online". Sub-claim dropped (the Open-source tile covers it).

### B. Intro tiles (one full-width row, 5 equal columns)

2. Web DAW — "Instruments, effects and audio recording to produce your own music."
   (Open: concrete device count, e.g. "40+ devices", vs the generic wording?)
3. Live Room — "Collaborate with others in real time, just share a link."
4. Education — "Learn by doing, with a classroom-friendly design." Links to opendaw.org/education.
5. Private — "No account, no subscription. Your data stays on your device, never seen by our servers."
6. Open source — "You own it. Make it yours, extend it, run it yourself."

### C. Left rail (actions + community)

6. New Project — big button + one-line "what to expect" (clean slate). Action: `service.newProject()`.
7. New Live Room — big button + one-line "what to expect" (jam in real time). Action: `connectRoom(service)`.
8. Open project bundle (.odb) — smaller import action, opens an `.odb` from disk.
9. Backup & Sync — Dropbox / Google Drive / Nextcloud with existing icons. Reuses
   `CloudBackup.backup(service.cloudAuthManager, "Dropbox" | "GoogleDrive")` and `NextcloudDialogs.browse/save`.
10. Sponsors ♥ — avatar grid, reuses `fetchSponsorStats` from `@/ui/pages/stats/data`. Fits the current count,
    holds up to 20 (no "+N more" cap).
11. Help & Feedback — Preferences, Manuals, Report a bug, Request a feature. Bug/feature deep-link to the issue forms
    directly (option 2): `issues/new?template=bug_report.yml` / `issues/new?template=feature_request.yml`
    (templates added; labels `bug` / `feature request`).
12. Links — opendaw.org, GitHub, Discord, Instagram (`instagram.com/opendaw.studio`),
    LinkedIn (`linkedin.com/company/opendaw-org`).

### D. Right column (the lists get the space)

13. Tab group: Projects, Templates, Demos, Samples, Soundfonts.
14. Demos tab — the api-fetched demo list; `DemoProject` card unchanged (cover, name, author, size, tags).
15. Projects empty state — a clickable "start with a demo project" that switches the tab group to Demos.

## Build list

1. `Dashboard.tsx` + `.sass`: hero strip (A), intro-tiles row (B), two-pane grid (C left rail, D right column).
2. `IntroTiles.tsx`: the 5 value tiles (items 2–6), Education links to opendaw.org/education.
3. `ActionButtons.tsx`: New Project, New Live Room, Open bundle (items 6–8).
4. `Resources.tsx`: add the Demos tab (items 13/14); Projects empty → "start with a demo project" (item 15).
5. `Backup.tsx`: item 9.
6. `Sponsors.tsx`: item 10.
7. `HelpFeedback.tsx`: item 11.
8. `Links.tsx`: item 12.
9. Dissolve `DemoProjects.tsx` into `ActionButtons` + the Demos tab.

## Decided / dropped

- Sub-claim removed (covered by the Open-source tile).
- Bug/feature buttons open their form directly (option 2), not the chooser. Templates already committed.
- No "What's new", no "Continue last project" (already the first entry in the Projects list), no engine/build info
  (the old engine is being removed), no Discord counts/newsletter.

## Open items

- Tile 2 (Web DAW): concrete device count or generic wording?
- Confirm sponsors sizing (grid up to 20, no cap link).
