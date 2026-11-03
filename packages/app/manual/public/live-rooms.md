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

## User Presence

A status bar shows all connected users with their name and color dot. Your pointer movement is tracked to indicate which panel you are currently working in, so other users can see where your focus is.

## Previewing and Recording in a Room

Picking devices in the device browser only changes your own copy of the project. The others hear and see nothing until you press Ok, and then they get just the device you chose. If someone removes what you are previewing or edits the device you are replacing, the browser closes and tells you.

A recording also stays with you until it has finished and its audio is saved. Everyone else then gets the complete take. It lands on the instrument's empty track, or on a new track below when someone placed a region there while you were recording. While you record, your name turns red with a record icon in the list of users.

Regions never overlap. If two people place or move a region onto the same spot at the same moment, one of them gives way: that change is taken back, or a recording moves to a track of its own, and a message tells them so.

## Asset Sharing (Technical Details)

The server only synchronizes the project structure (tracks, devices, regions, automation, etc.) using a CRDT protocol. Binary assets like audio samples and soundfonts are **never stored on the server**.

Instead, assets are exchanged directly between users via **peer-to-peer (P2P)** connections:

1. When a user needs an asset they do not have locally, a request is broadcast to all peers in the room.
2. Any peer that has the asset responds and a direct WebRTC data channel is established.
3. The asset is transferred in chunks directly between browsers.
4. Once received, the asset is stored in the user's local browser storage (OPFS) for future use.

This means your audio files and soundfonts remain private to the participants of the room and are never uploaded to or stored on any server.
