# Connect an AI Agent

An AI agent like Claude Code takes over the tedious work on your project. You describe a change in its chat, it writes a script with the openDAW scripting API and applies it to the project you have open. The music stays yours, the agent restructures and edits what is already there. Any agent that speaks MCP (Model Context Protocol) works.

## What an Agent Is Good For

Changes that take many clicks by hand, or the same edit over and over:

- **Restructure the project.** Rename and recolour tracks by a scheme, sort units, put related tracks into group buses, set up sends.
- **Repeat an edit everywhere.** Put the same compressor on every drum track, set all reverb sends to the same level, change a parameter on every instance of a device.
- **Edit notes in bulk.** Transpose, shift, shorten or change the velocity of the selected notes, apply the same edit to every region on a track.
- **Clean up.** Remove muted or empty tracks, unused effects or regions outside the song.
- **Answer questions about the project.** Which tracks use which device, where a parameter is automated, what the loop covers.

The agent sees what you work on: the device you edit, the region open in the editor, the selection, the playhead and the loop. So you can say "these notes" or "this device" and it knows what you mean. It asks you before it adds samples to your library.

## Making Music with an Agent

An agent can write notes, build sounds and arrange a song. What it cannot bring is what you hear in your head, the odd idea from somewhere else, the rule you break on purpose. Start from your own idea, take what comes back as a draft, and change it until it sounds like you. Play a part in yourself, tweak a sound, move a section. The more you shape it, the more it is your music.

## Building Your Own Plugins

An agent can also build new devices for openDAW from your description, without a connection to the studio. See
[Create a WebCLAP with AI](/manuals/create-webclap-with-ai).

## Connecting

Open the openDAW menu and choose **Connect Agent...**. Pick how the agent reaches your studio:

- **openDAW Server** works without installing anything. Click **Copy Command**, paste it into your terminal and run it once. The command holds your personal token, keep it private. Your project data passes through the openDAW server while the agent works, nothing is stored there.
- **Local Relay** keeps everything on your computer. Copy the command and run it once. It needs Node.js 18 or newer.

Then click **Connect**. While an agent is connected, the footer shows **Agent** next to Online. Start a new session in your agent and describe the change you want, for example "colour all drum tracks red and route them into a group bus".

## While the Agent Works

A dialog shows what the agent is doing, how long it has been working and how many times it called the studio. Everything it changes during one request becomes a single undo step, so one undo takes it all back. **Cancel** stops the agent from making further changes, the changes made so far stay and can be undone.

## Disconnecting

Click **Agent** in the footer or choose **Disconnect Agent** in the openDAW menu.

## Tokens

Your token for the openDAW server is valid for 30 days. **New Token** in the Connect Agent dialog replaces it at once and the old command stops working. Copy the command again and run it, it replaces the old setup. Each browser and each openDAW address (for example the development version) has its own token.

## Troubleshooting

- **The agent says no studio is connected.** Make sure Agent shows in the footer, then copy the command again in the same browser, run it and start a new agent session.
- **The command says the server already exists.** Copy the command again from the dialog, it removes older setups before adding the new one.
- **The agent waits for a dialog.** Scripts that show dialogs wait for you to answer them in the studio.
