use boxgraph::bytes::{ByteError, ByteReader, ByteWriter};

#[test]
fn exact_bytes_match_ts_format() {
    let mut writer = ByteWriter::new();
    writer.write_int(12);
    assert_eq!(writer.as_slice(), &[0x00, 0x00, 0x00, 0x0c], "int is 4-byte big-endian");

    let mut writer = ByteWriter::new();
    writer.write_short(1);
    assert_eq!(writer.as_slice(), &[0x00, 0x01], "short is 2-byte big-endian");

    let mut writer = ByteWriter::new();
    writer.write_bool(true);
    writer.write_bool(false);
    assert_eq!(writer.as_slice(), &[0x01, 0x00], "bool is one byte 0/1");

    let mut writer = ByteWriter::new();
    writer.write_string("AB");
    assert_eq!(writer.as_slice(), &[0x00, 0x00, 0x00, 0x02, 0x00, 0x41, 0x00, 0x42]);

    let mut writer = ByteWriter::new();
    writer.write_raw(&[0xAA, 0xBB, 0xCC]);
    assert_eq!(writer.as_slice(), &[0xAA, 0xBB, 0xCC]);
}

#[test]
fn primitives_round_trip() {
    let mut writer = ByteWriter::new();
    writer.write_byte(-7);
    writer.write_short(-12345);
    writer.write_int(-2_000_000_000);
    writer.write_long(-9_000_000_000_000_000_000);
    writer.write_float(core::f32::consts::PI);
    writer.write_double(core::f64::consts::E);
    writer.write_bool(true);
    let bytes = writer.into_bytes();
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(reader.read_byte().unwrap(), -7);
    assert_eq!(reader.read_short().unwrap(), -12345);
    assert_eq!(reader.read_int().unwrap(), -2_000_000_000);
    assert_eq!(reader.read_long().unwrap(), -9_000_000_000_000_000_000);
    assert_eq!(reader.read_float().unwrap(), core::f32::consts::PI);
    assert_eq!(reader.read_double().unwrap(), core::f64::consts::E);
    assert!(reader.read_bool().unwrap());
    assert_eq!(reader.remaining(), 0);
}

#[test]
fn strings_round_trip_including_unicode() {
    for text in ["", "AudioFileBox", "Hello 👻", "üöä — test"] {
        let mut writer = ByteWriter::new();
        writer.write_string(text);
        let bytes = writer.into_bytes();
        let mut reader = ByteReader::new(&bytes);
        assert_eq!(reader.read_string().unwrap(), text.to_string());
        assert_eq!(reader.remaining(), 0);
    }
}

#[test]
fn raw_bytes_round_trip_and_empty() {
    for payload in [vec![], vec![0u8], vec![1u8, 2, 3, 255, 0, 128]] {
        let mut writer = ByteWriter::new();
        writer.write_raw(&payload);
        let bytes = writer.into_bytes();
        let mut reader = ByteReader::new(&bytes);
        assert_eq!(reader.read_raw(payload.len()).unwrap(), payload);
    }
}

#[test]
fn reading_past_end_errors_not_panics() {
    let bytes = [0x00, 0x01];
    let mut reader = ByteReader::new(&bytes);
    assert_eq!(reader.read_int(), Err(ByteError::UnexpectedEnd));
}
