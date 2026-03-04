use spacetimedb::{table, reducer, Table, ReducerContext, Identity, Timestamp, ScheduleAt};
use spacetimedb::rand::Rng;

const COLOR_PALETTE: &[&str] = &[
    "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
    "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
];

const MAX_ASSET_SIZE: u64 = 100 * 1024 * 1024; // 100MB

#[table(name = room, public)]
pub struct Room {
    #[primary_key]
    pub id: String,
    pub creator_identity: Identity,
    pub is_persistent: bool,
    pub created_at: Timestamp,
    pub last_active_at: Timestamp,
}

#[table(name = room_participant, public)]
pub struct RoomParticipant {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: String,
    pub identity: Identity,
    pub display_name: String,
    pub color: String,
    pub joined_at: Timestamp,
}

#[table(name = room_asset, public)]
pub struct RoomAsset {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: String,
    pub asset_id: String,
    pub name: String,
    pub size_bytes: u64,
    pub mime_type: String,
    pub s3_url: Option<String>,
    pub uploaded_by: Identity,
}

#[reducer]
pub fn ping(ctx: &ReducerContext) -> Result<(), String> {
    log::info!("ping from {:?}", ctx.sender);
    Ok(())
}

#[reducer]
pub fn create_room(ctx: &ReducerContext) -> Result<(), String> {
    let charset = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = spacetimedb::rand::thread_rng();
    let room_id: String = (0..8)
        .map(|_| charset[rng.gen_range(0..charset.len())] as char)
        .collect();
    let now = ctx.timestamp;
    ctx.db.room().insert(Room {
        id: room_id.clone(),
        creator_identity: ctx.sender,
        is_persistent: false,
        created_at: now,
        last_active_at: now,
    });
    log::info!("room created: {}", room_id);
    Ok(())
}

#[reducer]
pub fn join_room(ctx: &ReducerContext, room_id: String, display_name: String) -> Result<(), String> {
    ctx.db.room().id().find(&room_id)
        .ok_or_else(|| format!("room not found: {}", room_id))?;
    let participant_count = ctx.db.room_participant().room_id().filter(&room_id).count();
    let color_index = participant_count % COLOR_PALETTE.len();
    let color = COLOR_PALETTE[color_index].to_string();
    ctx.db.room_participant().insert(RoomParticipant {
        id: 0,
        room_id: room_id.clone(),
        identity: ctx.sender,
        display_name,
        color,
        joined_at: ctx.timestamp,
    });
    log::info!("{:?} joined room {}", ctx.sender, room_id);
    Ok(())
}

#[reducer]
pub fn leave_room(ctx: &ReducerContext, room_id: String) -> Result<(), String> {
    let participant = ctx.db.room_participant().room_id().filter(&room_id)
        .find(|entry| entry.identity == ctx.sender)
        .ok_or_else(|| format!("not a participant in room: {}", room_id))?;
    ctx.db.room_participant().id().delete(&participant.id);
    log::info!("{:?} left room {}", ctx.sender, room_id);
    Ok(())
}

#[reducer]
pub fn promote_room(ctx: &ReducerContext, room_id: String) -> Result<(), String> {
    let mut room = ctx.db.room().id().find(&room_id)
        .ok_or_else(|| format!("room not found: {}", room_id))?;
    if room.creator_identity != ctx.sender {
        return Err("only the room creator can promote a room".to_string());
    }
    room.is_persistent = true;
    ctx.db.room().id().update(room);
    log::info!("room {} promoted to persistent", room_id);
    Ok(())
}

#[reducer]
pub fn register_asset(
    ctx: &ReducerContext,
    room_id: String,
    asset_id: String,
    name: String,
    size_bytes: u64,
    mime_type: String,
) -> Result<(), String> {
    ctx.db.room().id().find(&room_id)
        .ok_or_else(|| format!("room not found: {}", room_id))?;
    if size_bytes > MAX_ASSET_SIZE {
        return Err(format!("asset too large: {} bytes (max {})", size_bytes, MAX_ASSET_SIZE));
    }
    ctx.db.room_asset().insert(RoomAsset {
        id: 0,
        room_id: room_id.clone(),
        asset_id: asset_id.clone(),
        name,
        size_bytes,
        mime_type,
        s3_url: None,
        uploaded_by: ctx.sender,
    });
    log::info!("asset {} registered in room {}", asset_id, room_id);
    Ok(())
}

#[reducer]
pub fn update_asset_s3_url(
    ctx: &ReducerContext,
    room_id: String,
    asset_id: String,
    s3_url: String,
) -> Result<(), String> {
    let mut asset = ctx.db.room_asset().room_id().filter(&room_id)
        .find(|entry| entry.asset_id == asset_id)
        .ok_or_else(|| format!("asset {} not found in room {}", asset_id, room_id))?;
    asset.s3_url = Some(s3_url);
    ctx.db.room_asset().id().update(asset);
    log::info!("asset {} s3_url updated in room {}", asset_id, room_id);
    Ok(())
}

// --- WebRTC Signaling ---

#[table(name = webrtc_signal, public)]
pub struct WebrtcSignal {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: String,
    pub from_identity: Identity,
    pub to_identity: Identity,
    pub signal_type: String,
    pub payload: String,
    pub created_at: Timestamp,
}

#[reducer]
pub fn send_signal(
    ctx: &ReducerContext,
    room_id: String,
    to_identity: Identity,
    signal_type: String,
    payload: String,
) -> Result<(), String> {
    if !["offer", "answer", "ice"].contains(&signal_type.as_str()) {
        return Err(format!("Invalid signal type: {}", signal_type));
    }
    if payload.len() > 16 * 1024 {
        return Err("Signal payload too large (max 16KB)".to_string());
    }
    ctx.db.webrtc_signal().insert(WebrtcSignal {
        id: 0,
        room_id,
        from_identity: ctx.sender,
        to_identity,
        signal_type,
        payload,
        created_at: ctx.timestamp,
    });
    Ok(())
}

// --- Presence ---

#[table(name = presence, public)]
pub struct Presence {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: String,
    pub identity: Identity,
    pub display_name: String,
    pub color: String,
    pub cursor_x: f64,
    pub cursor_y: f64,
    pub cursor_target: String,
    pub last_seen: Timestamp,
}

#[reducer]
pub fn update_presence(
    ctx: &ReducerContext,
    room_id: String,
    cursor_x: f64,
    cursor_y: f64,
    cursor_target: String,
) -> Result<(), String> {
    let existing = ctx.db.presence().room_id().filter(&room_id)
        .find(|entry| entry.identity == ctx.sender);
    match existing {
        Some(mut record) => {
            record.cursor_x = cursor_x;
            record.cursor_y = cursor_y;
            record.cursor_target = cursor_target;
            record.last_seen = ctx.timestamp;
            ctx.db.presence().id().update(record);
        }
        None => {
            let participant = ctx.db.room_participant().room_id().filter(&room_id)
                .find(|entry| entry.identity == ctx.sender)
                .ok_or("Not in this room")?;
            ctx.db.presence().insert(Presence {
                id: 0,
                room_id,
                identity: ctx.sender,
                display_name: participant.display_name.clone(),
                color: participant.color.clone(),
                cursor_x,
                cursor_y,
                cursor_target,
                last_seen: ctx.timestamp,
            });
        }
    }
    Ok(())
}

// --- BoxGraph State Sync ---

#[table(name = box_state, public)]
pub struct BoxState {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: String,
    pub box_uuid: String,
    pub box_name: String,
    pub data: String,
}

#[reducer]
pub fn box_create(ctx: &ReducerContext, room_id: String, box_uuid: String, box_name: String, data: String) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("Box data too large (max 1MB)".to_string());
    }
    ctx.db.box_state().insert(BoxState { id: 0, room_id, box_uuid, box_name, data });
    Ok(())
}

#[reducer]
pub fn box_update(ctx: &ReducerContext, room_id: String, box_uuid: String, data: String) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("Box data too large (max 1MB)".to_string());
    }
    let mut state = ctx.db.box_state().room_id().filter(&room_id)
        .find(|entry| entry.box_uuid == box_uuid)
        .ok_or("Box not found")?;
    state.data = data;
    ctx.db.box_state().id().update(state);
    Ok(())
}

#[reducer]
pub fn box_delete(ctx: &ReducerContext, room_id: String, box_uuid: String) -> Result<(), String> {
    let state = ctx.db.box_state().room_id().filter(&room_id)
        .find(|entry| entry.box_uuid == box_uuid)
        .ok_or("Box not found")?;
    ctx.db.box_state().id().delete(&state.id);
    Ok(())
}

// --- Scheduled Cleanup ---

#[table(name = cleanup_schedule, scheduled(cleanup_stale_rooms))]
pub struct CleanupSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

#[reducer]
pub fn cleanup_stale_rooms(ctx: &ReducerContext, _schedule: CleanupSchedule) -> Result<(), String> {
    let stale_room_ids: Vec<String> = ctx.db.room().iter()
        .filter(|room| !room.is_persistent)
        .filter(|room| {
            ctx.db.room_participant().room_id().filter(&room.id).count() == 0
        })
        .map(|room| room.id.clone())
        .collect();
    for room_id in stale_room_ids {
        for asset in ctx.db.room_asset().room_id().filter(&room_id).collect::<Vec<_>>() {
            ctx.db.room_asset().id().delete(&asset.id);
        }
        for signal in ctx.db.webrtc_signal().room_id().filter(&room_id).collect::<Vec<_>>() {
            ctx.db.webrtc_signal().id().delete(&signal.id);
        }
        for record in ctx.db.presence().room_id().filter(&room_id).collect::<Vec<_>>() {
            ctx.db.presence().id().delete(&record.id);
        }
        for entry in ctx.db.box_state().room_id().filter(&room_id).collect::<Vec<_>>() {
            ctx.db.box_state().id().delete(&entry.id);
        }
        ctx.db.room().id().delete(&room_id);
        log::info!("Cleaned up stale room: {}", room_id);
    }
    Ok(())
}
