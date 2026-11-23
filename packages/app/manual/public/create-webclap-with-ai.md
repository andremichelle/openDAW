# Create a WebCLAP with AI

You can make your own audio effects, instruments and MIDI effects for openDAW by describing them to an AI coding
agent. You do not need to know how to program. The agent builds the plugin, you listen to it in the browser and tell
the agent what to change. When you like it, you use it in openDAW like any other device, and you can share it with
every openDAW user.

Your plugin is a [WebCLAP](/manuals/devices/audio/wclap): it shows its controls in the device panel like openDAW's own
devices, and you can automate every control. If your idea needs more room, a large display or a detailed editor, the
agent asks whether you want a bigger window for it, opened with a Big View button on the device.

## What You Need

1. A coding agent, for example [Claude Code](https://claude.com/claude-code), Codex or Cursor.
2. A Mac or Linux computer. On Windows, run the agent in [WSL](https://learn.microsoft.com/windows/wsl/install).
3. A free [GitHub](https://github.com/signup) account, only to share your plugin.

The agent installs everything else.

## 1. Teach Your Agent

You do not install anything yourself. Copy this message into your agent's chat, once, and send it:

```
Please set up the openDAW WebCLAP skill on this computer.
If Node.js is not installed yet, install it for me first.
Then run: npx skills add https://webclap.opendaw.studio -g
```

The agent installs Node.js if your computer does not have it yet, then the skill. If your computer asks for your
password while it does, type it in, that is the only thing you do. The skill teaches the agent how openDAW plugins are
built, how they look and behave in the device panel, and how to test and share them. When the agent says it is done,
start a new chat with it, so it uses the skill. Your first plugin takes a few minutes longer, the agent downloads its
build tools (about 1 GB) once.

## 2. Describe Your Plugin

Start your agent in an empty folder and describe what you want, for example:

```
Make an openDAW audio effect: a tape saturation with Drive, Tone, Wow and Mix.
```

```
Make an openDAW instrument: a soft pad synth with two detuned saws, a slow filter and a long release.
```

```
Make an openDAW MIDI effect: an arpeggiator that follows the song tempo, up, down or random, in sixteenths.
```

The agent asks for your name (shown as the plugin's maker) and may ask one question about the idea. Then it builds
the plugin and checks it.

## 3. Try It

The agent opens a preview in your browser on the [open-webclap](https://webclap.opendaw.studio) site. It runs your
plugin in openDAW's engine and shows the device panel, and the window below it if your plugin has one.

1. Click **Start audio**.
2. For an effect, pick an **Input**: a test tone, noise, an audio file or your microphone.
3. For an instrument or MIDI effect, play the keyboard on the page, your computer keys or a MIDI keyboard. **Play**
   starts the transport for anything that follows the tempo.
4. Turn the knobs and listen.

Tell the agent what you hear and what you want instead: "the drive is too harsh", "add a low cut", "the release
should go up to ten seconds", "make the knobs bigger". After every change the preview reloads the plugin by itself
and keeps your settings.

## 4. Use It in openDAW

The agent saves the finished plugin as a file ending in `.wclap.tar.gz` and tells you where.

1. In openDAW, add a **WebCLAP** device to a track: an audio effect, an instrument or a MIDI effect, like your plugin.
2. Click **Load Plugin > Import WebCLAP...** and pick the file.

The plugin is stored in your browser, your projects keep it. When you change the plugin later, ask the agent for a
new version and import it the same way.

## 5. Share It

Ask your agent to share the plugin. It checks everything once more and tells you what it will do, then waits for your
OK. It opens a pull request to the community repository
[opendaw-commons](https://github.com/andremichelle/opendaw-commons) from your GitHub account. If you are not signed in
to GitHub on this computer yet, the agent opens the browser for you to sign in.

Every plugin is reviewed by a person before it goes live. Once accepted, it appears in every openDAW Studio under
**Load Plugin > Community**. What happens after the pull request is explained in
[Community WebCLAPs](/manuals/community-webclaps).

## Good to Know

1. Your plugin's source code stays in the folder on your computer. Keep it to make changes later.
2. A plugin you share is public, with its source code, under the license in its folder (MIT unless you ask for
   another).
3. The agent follows openDAW's rules for plugins: controls that look and behave like openDAW's own, right-click and
   double-click on a control open openDAW's menu and value entry, every change is one undo step, and the sound starts
   and stops without clicks.
4. Something does not work? Tell the agent what you see or hear, in your own words.
