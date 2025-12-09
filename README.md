<p align="center">
  <img src="https://raw.githubusercontent.com/andremichelle/openDAW/refs/heads/main/packages/app/studio/public/favicon.svg" height="120"/>
  <h1 align="center">openDAW</h1>
</p>

<p align="center">
<a href="https://www.gnu.org/licenses/agpl-3.0.html" rel="nofollow"><img src="https://img.shields.io/badge/license-AGPLv3-blue.svg" alt="License: AGPLv3"></a>
<a href="https://discord.gg/ZRm8du7vn4" rel="nofollow"><img src="https://img.shields.io/discord/1241019312328675399?label=Discord&logo=discord&logoColor=white" alt="discord server"></a>
<a href="https://github.com/andremichelle/opendaw" rel="nofollow"><img src="https://img.shields.io/github/stars/andremichelle/opendaw" alt="stars"></a>
</p>

**openDAW** is a next-generation web-based Digital Audio Workstation (DAW) designed to **democratize** music production
and to **resurface the process of making music** by making **high-quality** creation tools accessible to everyone, with
a strong focus on **education** and data-privacy. Please consider supporting this project
on [Patreon](https://www.patreon.com/join/openDAW) or [ko-fi](https://ko-fi.com/opendaw).

<p align="center">
<img src="https://raw.githubusercontent.com/andremichelle/openDAW/refs/heads/main/assets/studio-teaser.png"/>
</p>

---

## Open-Source

We are committed to transparency and community-driven development.

The source code for openDAW is available under **AGPL v3 (or later)**

### Built on Trust and Transparency

**openDAW stands for radical simplicity and respect.**

- **No SignUp**
- **No Tracking**
- **No Cookie Banners**
- **No User Profiling**
- **No Terms & Conditions**
- **No Ads**
- **No Paywalls**
- **No Data Mining**

---

## Huge Shoutout To The Incredible openDAW Community!

To everyone who has contributed feedback, reported bugs, suggested improvements, or helped spread the word — thank you!
Your support is shaping openDAW into something truly powerful!

Thank
you [@ccswdavidson](https://github.com/ccswdavidson), [@Chaosmeister](https://github.com/Chaosmeister), [@jeffreylouden](https://github.com/jeffreylouden), [@solsos](https://github.com/solsos), [@TheRealSyler](https://github.com/TheRealSyler), [@Trinitou](https://github.com/Trinitou),
and [@xnstad](https://github.com/xnstad) for testing the repositories and identifying issues during the installation of
openDAW!

Special shout-out to the biggest bug hunters: [kanaris](https://kanaris.net/), [@Chaosmeister](https://github.com/Chaosmeister)
and [BeatMax Prediction](https://linktr.ee/beatmax_prediction). Your relentless attention to detail made a huge
difference!

Huge thanks to our [ambassadors](https://opendaw.org/ambassadors), whose dedication and outreach amplify our mission!

## And big hugs to all our supporters!

### openDAW Visionary — $25.00

- Polarity
- kanaris
- Stephen Tai
- Thad Guidry
- Pathfinder
- One Sound Every Day (santino)

### openDAW Supporter — $5.00

- Cal Lycus
- Jetdarc
- Truls Enstad
- p07a
- Ynot Etluhcs
- Mats Gisselson
- Dado
- centomila
- Ola
- SKYENCE
- BeatMax_Prediction
- Kim T
- Nyenoidz
- Bruce Hunter
- Steve Meiers
- 4ohm
- Yito
- Shawn Lukas
- Tommes
- David Thompson
- Harry Gillich
- OxVolt
- Wojciech Miłkowski
- Client
- skyboundzoo
- JHINZ
- Mark Dammer
- fork-kun
- Martin Eigel

---

### openDAW Devices

#### Stock Plugins

* Vaporisateur (simple synth with classical waveforms)
* Playfield (sample player with individual effect chains)
* Nano (simple sampler pitching a single audio file)
* Tape (playback device for audio regions and clips)
* Soundfont (simple soundfont player)
* MIDI Output (to external devices)
* Stereo Tool (volume, panning and/or invert the stereo signal)
* Delay (stereo delay with cross and filter options)
* Crusher (degenerates audio signal)
* Cheap Reverb (FreeVerb variation)
* Revamp (Graphical Equalizer)
* Arpeggio (midi effect)
* Pitch (offsets midi note pitches)
* Zeitgeist (transforms time)
* Velocity (Manipulates velocities of incoming notes)
* Fold (waveform folding algorithm with oversampling)
* Tidal (Shapes rhythm and space through volume and pan)
* Dattorro Reverb (Dense algorithmic reverb based on Dattorro's design)

#### Ported Plugins (Excluded in commercial license)

* [Compressor](https://github.com/p-hlp/CTAGDRC) (CTAG Dynamic Range Compressor)

### Repositories

* [openDAW](https://github.com/andremichelle/opendaw)
* [openDAW-headless (SDK)](https://github.com/andremichelle/opendaw-headless)
* [openDAW-headless @naomiaro](https://github.com/naomiaro/opendaw-test) (openDAW-headless fork with more docs and
  examples)

### Roadmap

This roadmap represents an estimation of the upcoming development steps. Timelines and priorities may shift as openDAW
evolves.

#### 2025/Q4

- [X] Preset API
- [X] Full implementation of connecting several cloud services to store samples, projects, and presets
- [X] Implement audio playback algorithms (pitch, stretch, absolute) including interpolation
- [ ] ~~Sample editor~~
- [ ] ~~Pushing event flow and painting routines into SDK~~

#### 2026/Q1

- [ ] Fade-in and out on audio-regions
- [ ] Signature automation track
- [ ] Tempo automation track
- [ ] Fine-tune recording including loops (takes)

#### 2026/Q2

- [ ] Fine-tune timeline clips (recording, switch times)
- [ ] Fine-tune MIDI effects
- [ ] Implement missing region actions like flatten
- [ ] Polish UI

#### 2026/Q3

- [ ] Testing & QA
- [ ] Launch 1.0

#### Future

- [ ] Start Modular System
- [ ] Add more synthesizers
- [ ] Add more effect devices

### Prepare, Clone, Installation, and Run

openDAW tries to avoid external libraries and frameworks. The following is a list of the external libraries we currently
use in the web studio:

* [jszip](https://www.npmjs.com/package/jszip) (for openDAW project bundle file)
* [markdown-it](https://www.npmjs.com/package/markdown-it) + [markdown-it-table](https://www.npmjs.com/package/markdown-it-table) (
  for help pages)
* [d3-force](https://d3js.org/d3-force) (for graph debugging)
* [soundfont2](https://github.com/Mrtenz/soundfont2) (for soundfont loading)
* [zod](https://zod.dev) (schema validation)
* [ffmpeg](https://github.com/ffmpegwasm/ffmpeg.wasm) (decoding/encoding)

Before starting, ensure you have the following installed on your system:

- [Git](https://git-scm.com/) is required for cloning the repository and managing submodules.
- [mkcert](https://github.com/FiloSottile/mkcert#installation) is required to create a certificate for developing with
  https protocol.
- [Node.js](nodejs.org) version **>= 23**. This is necessary for running the development server and installing
  dependencies.
- [Sass](https://sass-lang.com/) While Sass is handled internally during the development process, you will need to
  ensure you have the
  binaries available in your environment if used outside the build system.
- [TypeScript](https://www.typescriptlang.org/)
- [OpenSSL](https://openssl-library.org/) For generating local development certificates (), OpenSSL needs to be
  installed on
  your system. Most Linux/macOS systems have OpenSSL pre-installed.

### Clone

`git clone https://github.com/andremichelle/opendaw.git && cd opendaw`

### Installation

* `npm run cert` (only for the very first time)
* `npm run clean` (to revert to clean slate, removes all `node_modules` and `dist` folders)
* `npm install` (for the first time and after `npm run clean`)
* `npm run build` (for the first time and after `npm run clean`)
* `npm run dev:studio` | `npm run dev:headless` (start dev server)
* Navigate to https://localhost:8080 (port is important > cors sample api)

### Flow Charts

<img width="6551" height="7057" alt="image" src="https://github.com/user-attachments/assets/266a9fb2-4b72-4752-bcf1-85fda2ff2cf1" />

---

[![Custom Caption: Watch the Demo](https://img.youtube.com/vi/VPTXeJY6Eaw/0.jpg)](https://www.youtube.com/watch?v=VPTXeJY6Eaw)

Watch Polarity's Video *"there's a new FREE DAW in town"*

## Get Involved

We welcome contributions from developers, musicians, educators, and enthusiasts. To learn more about how you can
participate, visit our [Contribute](https://opendaw.org/contribute) page.

### What We Are Looking For:

1. **Offline desktop build (e.g., via Tauri) or a standalone installable PWA** — offer offline capability.
2. **Cloud-agnostic project storage** — a facade layer that lets users plug in different cloud services (e.g., Drive,
   S3, Dropbox) for projects and sample libraries.
3. **Live remote collaboration** — real-time session sharing and sync so multiple users can edit the same project
   concurrently.
4. **AI manual assistant** — an embedded agent that answers context-aware questions and guides users through features as
   they work.
5. **AI-powered stem splitting** — integrated source-separation to extract vocals, drums, and other stems directly
   inside the DAW.
6. **Import and Export** - Contribute every possible file format IO

## Links

* [opendaw.studio (prototype)](https://opendaw.studio)
* [opendaw.org (website)](https://opendaw.org)
* [openDAW on Discord](https://discord.opendaw.studio)
* [openDAW SDK](https://www.npmjs.com/org/opendaw)
* [openDAW on Patreon](https://www.patreon.com/join/openDAW)
* [openDAW on ko-fi](https://ko-fi.com/opendaw)
* [LinkedIn](https://www.linkedin.com/company/opendaw-org/)
* [Instagram](https://www.instagram.com/opendaw.studio)

## Contributions

### Icons

* "Wave" by Gregor Cresnar
  from [Noun Project](https://thenounproject.com/icon/wave-6250020/) (CC BY 3.0)
* "Compress" by Gregor Cresnar
  from [Noun Project](https://thenounproject.com/browse/icons/term/compress/) (CC BY 3.0)
* "Waveforms" by [Austin Andrews](https://github.com/Templarian/MaterialDesign)
* "futurism" by Martin Königsmann from [Noun Project](https://thenounproject.com/icon/futurism-4565401/)
* "tape reel" by Evgeny Filatov from [thenounproject](https://thenounproject.com/icon/tape-reel-2216293/)

## Dual-Licensing Model

openDAW is available **under two alternative license terms**:

| Option                    | When to choose it                                                                                                    | Obligations                                                                                                                                                                                                                                                       |
|---------------------------|----------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **A. AGPL v3 (or later)** | You are happy for the entire work that includes openDAW to be released under AGPL-compatible open-source terms.      | – Must distribute complete corresponding source code under AGPL.<br>– Must keep copyright & licence notices.<br>– Applies both to distribution **and** to public use via network/SaaS (§13).<br>– May run openDAW privately in any software, open or closed (§0). |
| **B. Commercial Licence** | You wish to incorporate openDAW into **closed-source** or otherwise licence-incompatible software or SaaS offerings. | – Pay the agreed fee.<br>– No copyleft requirement for your own source code.<br>– Other terms as per the signed agreement.                                                                                                                                        |

> **How to obtain the Commercial License**  
> Email `andre.michelle@opendaw.org` with your company name, product description, and expected distribution volume.

If you redistribute or run modified versions of openDAW for public use **without** a commercial license, the AGPL v3
terms apply automatically.

## License

[AGPL v3 (or later)](https://www.gnu.org/licenses/agpl-3.0.txt) © 2025 André Michelle
