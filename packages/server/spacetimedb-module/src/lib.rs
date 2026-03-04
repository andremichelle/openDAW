use spacetimedb::{table, reducer, ReducerContext, Identity, Timestamp};

#[table(name = room, public)]
pub struct Room {
    #[primary_key]
    pub id: String,
    pub creator_identity: Identity,
    pub is_persistent: bool,
    pub created_at: Timestamp,
    pub last_active_at: Timestamp,
}

#[reducer]
pub fn ping(ctx: &ReducerContext) -> Result<(), String> {
    log::info!("ping from {:?}", ctx.sender);
    Ok(())
}
