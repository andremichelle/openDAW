// Shared memory + own region (12 MiB). This module also carries a 1 MiB heap arena for its custom
// allocator, which lands in this region too. See plans/wasm-audio/05-memory.md.
fn main() {
    println!("cargo:rustc-cdylib-link-arg=--import-memory");
    println!("cargo:rustc-cdylib-link-arg=--global-base=12582912"); // 12 MiB (data slab; see comp-filter note)
}
