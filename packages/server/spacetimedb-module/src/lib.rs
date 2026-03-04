use spacetimedb::{table, reducer, Table, ReducerContext, Identity, Timestamp};
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
