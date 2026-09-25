//! The DX7 voice data: the 155-byte unpacked patch, the 128-byte packed cartridge slot (`Cartridge::
//! unpackProgram` / Synth_Dexed `encodeVoice`), the 4104-byte bank checksum and Dexed's init voice.

pub const PATCH_SIZE: usize = 155;
pub const PACKED_SIZE: usize = 128;
pub const BANK_SIZE: usize = 4104;
pub const BANK_BODY: usize = 4096;

/// Dexed's INIT VOICE (`resetToInitVoice`): OP1 a full-level carrier on algorithm 1, everything else silent.
pub const INIT_VOICE: [u8; PATCH_SIZE] = [
    99, 99, 99, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 7,
    99, 99, 99, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 7,
    99, 99, 99, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 7,
    99, 99, 99, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 7,
    99, 99, 99, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 7,
    99, 99, 99, 99, 99, 99, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 99, 0, 1, 0, 7,
    99, 99, 99, 99, 50, 50, 50, 50,
    0, 0, 1,
    35, 0, 0, 0, 1, 0,
    3, 24,
    73, 78, 73, 84, 32, 86, 79, 73, 67, 69
];

pub fn unpack(bulk: &[u8]) -> [u8; PATCH_SIZE] {
    let mut patch = [0u8; PATCH_SIZE];
    for op in 0..6 {
        let src = op * 17;
        let dst = op * 21;
        for i in 0..11 {
            patch[dst + i] = bulk[src + i] & 0x7F;
        }
        let leftrightcurves = bulk[src + 11] & 0xF;
        patch[dst + 11] = leftrightcurves & 3;
        patch[dst + 12] = (leftrightcurves >> 2) & 3;
        let detune_rs = bulk[src + 12] & 0x7F;
        patch[dst + 13] = detune_rs & 7;
        let kvs_ams = bulk[src + 13] & 0x1F;
        patch[dst + 14] = kvs_ams & 3;
        patch[dst + 15] = (kvs_ams >> 2) & 7;
        patch[dst + 16] = bulk[src + 14] & 0x7F;
        let fcoarse_mode = bulk[src + 15] & 0x3F;
        patch[dst + 17] = fcoarse_mode & 1;
        patch[dst + 18] = (fcoarse_mode >> 1) & 0x1F;
        patch[dst + 19] = bulk[src + 16] & 0x7F;
        patch[dst + 20] = (detune_rs >> 3) & 0x7F;
    }
    for i in 0..8 {
        patch[126 + i] = bulk[102 + i] & 0x7F;
    }
    patch[134] = bulk[110] & 0x1F;
    let oks_fb = bulk[111] & 0xF;
    patch[135] = oks_fb & 7;
    patch[136] = oks_fb >> 3;
    patch[137] = bulk[112] & 0x7F;
    patch[138] = bulk[113] & 0x7F;
    patch[139] = bulk[114] & 0x7F;
    patch[140] = bulk[115] & 0x7F;
    let lpms_lfw_lks = bulk[116] & 0x7F;
    patch[141] = lpms_lfw_lks & 1;
    patch[142] = (lpms_lfw_lks >> 1) & 7;
    patch[143] = lpms_lfw_lks >> 4;
    patch[144] = bulk[117] & 0x7F;
    for i in 0..10 {
        patch[145 + i] = bulk[118 + i] & 0x7F;
    }
    patch
}

pub fn pack(patch: &[u8; PATCH_SIZE]) -> [u8; PACKED_SIZE] {
    let mut bulk = [0u8; PACKED_SIZE];
    for op in 0..6 {
        let src = op * 21;
        let dst = op * 17;
        bulk[dst..dst + 11].copy_from_slice(&patch[src..src + 11]);
        bulk[dst + 11] = ((patch[src + 12] & 3) << 2) | (patch[src + 11] & 3);
        bulk[dst + 12] = ((patch[src + 20] & 0x0F) << 3) | (patch[src + 13] & 7);
        bulk[dst + 13] = ((patch[src + 15] & 7) << 2) | (patch[src + 14] & 3);
        bulk[dst + 14] = patch[src + 16];
        bulk[dst + 15] = ((patch[src + 18] & 0x1F) << 1) | (patch[src + 17] & 1);
        bulk[dst + 16] = patch[src + 19];
    }
    bulk[102..110].copy_from_slice(&patch[126..134]);
    bulk[110] = patch[134] & 0x1F;
    bulk[111] = ((patch[136] & 1) << 3) | (patch[135] & 7);
    bulk[112..116].copy_from_slice(&patch[137..141]);
    bulk[116] = ((patch[143] & 7) << 4) | ((patch[142] & 7) << 1) | (patch[141] & 1);
    bulk[117] = patch[144];
    bulk[118..128].copy_from_slice(&patch[145..155]);
    bulk
}

/// The two's-complement sum of `bytes`, masked to 7 bits (`sysexChecksum`).
pub fn checksum(bytes: &[u8]) -> u8 {
    let mut sum: i32 = 0;
    for byte in bytes {
        sum -= *byte as i32;
    }
    (sum & 0x7F) as u8
}

/// The 32 packed voices of a bank file: a 4104-byte bulk dump (header + body + checksum + F7) or the
/// bare 4096-byte body. `None` when neither the size nor the dump's checksum fits.
pub fn bank_body(bytes: &[u8]) -> Option<&[u8]> {
    match bytes.len() {
        BANK_SIZE => {
            let header_ok = bytes[0] == 0xF0 && bytes[1] == 0x43 && (bytes[2] & 0xF0) == 0 && bytes[3] == 0x09 && bytes[4] == 0x20 && bytes[5] == 0x00;
            let body = &bytes[6..6 + BANK_BODY];
            if header_ok && checksum(body) == bytes[6 + BANK_BODY] && bytes[BANK_SIZE - 1] == 0xF7 {Some(body)} else {None}
        }
        BANK_BODY => Some(bytes),
        _ => None
    }
}

pub fn voice_name(patch: &[u8; PATCH_SIZE]) -> [u8; 10] {
    let mut name = [0u8; 10];
    name.copy_from_slice(&patch[145..155]);
    name
}
