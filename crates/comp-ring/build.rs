// Shared memory + own region (8 MiB). See plans/wasm-audio/05-memory.md.
fn main() {
    println!("cargo:rustc-cdylib-link-arg=--import-memory");
    println!("cargo:rustc-cdylib-link-arg=--global-base=8388608"); // 8 MiB (data slab; see comp-filter note)
}
