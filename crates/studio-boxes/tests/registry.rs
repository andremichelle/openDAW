use boxgraph::field::FieldType;
use studio_boxes::registry;

#[test]
fn registry_builds_with_known_boxes() {
    let registry = registry();
    assert!(registry.len() > 50, "expected the full box set, got {}", registry.len());
    assert!(registry.contains_key("RootBox"));
    assert!(registry.contains_key("AudioFileBox"));
    assert!(registry.contains_key("MetaDataBox"));
}

#[test]
fn metadata_box_field_types() {
    let registry = registry();
    let meta = registry.get("MetaDataBox").expect("MetaDataBox present");
    assert_eq!(meta.get(&1), Some(&FieldType::Pointer));
    assert_eq!(meta.get(&2), Some(&FieldType::String));
    assert_eq!(meta.get(&3), Some(&FieldType::String));
}

#[test]
fn root_box_has_hook_and_nested_object() {
    let registry = registry();
    let root = registry.get("RootBox").expect("RootBox present");
    assert_eq!(root.get(&2), Some(&FieldType::Hook));
    match root.get(&40) {
        Some(FieldType::Object(fields)) => assert_eq!(fields.len(), 5),
        other => panic!("expected nested object at key 40, got {other:?}")
    }
}

#[test]
fn audio_file_box_has_floats_strings_and_hook() {
    let registry = registry();
    let audio = registry.get("AudioFileBox").expect("AudioFileBox present");
    assert_eq!(audio.get(&1), Some(&FieldType::Float32));
    assert_eq!(audio.get(&2), Some(&FieldType::Float32));
    assert_eq!(audio.get(&3), Some(&FieldType::String));
    assert_eq!(audio.get(&10), Some(&FieldType::Hook));
}
