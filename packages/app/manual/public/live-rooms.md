# Live Rooms

Live Rooms let you collaborate on a project in real time with other users. Everyone in the same room sees and edits the same project simultaneously.

## Creating or Joining a Room

Open the openDAW menu and select **Join Live Room...**. A dialog will ask for:

- **Room Name** -- lowercase letters, numbers, hyphens, dots, and underscores (max 16 characters). If no room with that name exists, a new one is created. If it already exists, you join the existing session.
- **Your Name** -- how other users will see you (max 16 characters).
- **Your Color** -- pick a color from the palette. This color identifies you in the room status bar and the chat.

The dialog shows a shareable join link (e.g. `https://opendaw.studio/join/my-room`). Click it to copy it to the clipboard and send it to anyone you want to invite.

You can also join directly by visiting a `/join/{roomName}` URL in your browser.

## Sharing Your Project

When you connect to an **empty room**, your current project is automatically published as the shared session. Everyone who joins afterwards receives a copy of that project state.

When you join a room that **already has participants**, you download the existing project from the room. Your local project is replaced by the shared one for the duration of the session.

## Room Lifecycle

- A room is created the moment the first user connects.
- The room stays open as long as at least one user is connected.
- There is no designated host. If the person who started the room leaves, everyone else continues collaborating normally.
- When the **last user leaves**, the room is scheduled for deletion after a short grace period (~60 seconds). If someone reconnects before the timeout, the room stays alive.
- After the timeout, the room and all its data are permanently deleted from the server.

**Rooms are transient.** Nothing is persisted on the server after the room closes. Make sure to save your project locally before leaving.

## Chat

While in a room, a chat tab appears on the right edge of the screen. Click it to open the chat overlay.

- Messages are visible to all users in the room.
- Each message shows the sender's name and color.
- Messages are synchronized through the room, so late joiners can see the conversation history from the current session.
- Like the room itself, the chat history is transient and disappears when the room closes.

## Audio and Video Call

The chat overlay starts with a call area. Anyone in the room can start a call with **Join** (microphone only) or **Join with Video**. A green dot on the chat tab shows that a call is running. A call allows up to 6 people. Audio and video go directly between the participants and never through the server.

- **Microphone, camera and screen.** Mute, turn the camera on or off, or present a screen or browser tab. Presenting a tab can include its audio.
- **Hold to talk.** While muted, hold the microphone button to talk.
- **Raise hand.** Raise a hand to ask for the floor.
- **Tiles.** Each participant gets a tile that lights up while they speak. Hover a tile to change that person's volume for you, pin it or show it fullscreen. Double click pins a tile. A presented screen is pinned automatically.
- **Widen.** The arrow button in the call header makes the panel wider for bigger video.
- **Closed panel.** While you are in a call and the chat is closed, a small dock above the chat tab keeps the mute and leave buttons and shows who is speaking.

The settings button in the call header offers:

- **Microphone, Camera and Speaker** to pick the devices for the call.
- **Direct Audio** sends your microphone in stereo at a high bitrate without echo cancellation, noise suppression or automatic gain. Use it for instruments and listening sessions, with headphones.
- **Lower Call Volume During Playback** turns the call down while the project plays.
- **Silence Call While Recording** mutes incoming call audio during a recording so it does not bleed into your take.
- **Mirror My Camera** flips your own preview.

Shortcuts: ⌥⇧M (Alt+Shift+M) mutes or unmutes, ⌥⇧V (Alt+Shift+V) turns the camera on or off, ⌥⇧H (Alt+Shift+H) raises or lowers your hand. The call audio plays outside the project and is never part of a recording or an export.

## Follow Playback

Click a name in the room status bar and choose **Follow Playback** to listen along with that person. When they play, stop or jump, your playback does the same. If they are already playing, you start right at their current position. The person you follow shows a broadcast icon, followers show a headphone icon.

- While following, your own play, stop and record controls are disabled.
- Following someone who follows another person makes you follow the person at the end of that chain.
- Following ends when you choose **Stop Following** from your own name, when the person you follow leaves the room or starts following someone else, or when you leave the room. Your controls come back right away.
- Everyone plays the same project, so tempo changes and the loop area match automatically. Playback is close, not sample exact.

## User Presence

A status bar shows all connected users with their name and color dot. Your pointer movement is tracked to indicate which panel you are currently working in, so other users can see where your focus is.

## Asset Sharing (Technical Details)

The server only synchronizes the project structure (tracks, devices, regions, automation, etc.) using a CRDT protocol. Binary assets like audio samples and soundfonts are **never stored on the server**.

Instead, assets are exchanged directly between users via **peer-to-peer (P2P)** connections:

1. When a user needs an asset they do not have locally, a request is broadcast to all peers in the room.
2. Any peer that has the asset responds and a direct WebRTC data channel is established.
3. The asset is transferred in chunks directly between browsers.
4. Once received, the asset is stored in the user's local browser storage (OPFS) for future use.

This means your audio files and soundfonts remain private to the participants of the room and are never uploaded to or stored on any server.
