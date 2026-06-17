// Shared memory + own region (4 MiB) so this module's stack is disjoint from the engine and the
// other device modules. See plans/wasm-audio/05-memory.md.
fn main() {
    println!("cargo:rustc-cdylib-link-arg=--import-memory");
    // Relocates this module's static DATA into its own slab (verified disjoint). NOTE: rust-lld
    // pins the shadow stack at [0, stack-size) regardless — see plans/wasm-audio/05-memory.md.
    println!("cargo:rustc-cdylib-link-arg=--global-base=4194304"); // 4 MiB
}
