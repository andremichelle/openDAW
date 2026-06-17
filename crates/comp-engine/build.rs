// Engine keeps the default low region (~1 MiB) and owns the audio buffers, descriptors and the
// devices' per-instance state blocks in shared memory.
fn main() {
    println!("cargo:rustc-cdylib-link-arg=--import-memory");
}
