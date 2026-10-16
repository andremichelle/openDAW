use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let root = manifest.join("../../../..");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("host.js");
    let status = Command::new(root.join("node_modules/.bin/esbuild"))
        .arg(manifest.join("host.ts"))
        .args(["--bundle", "--format=iife", "--platform=neutral", "--main-fields=module,main", "--log-level=warning"])
        .arg(format!("--outfile={}", out.display()))
        .current_dir(&root)
        .status()
        .expect("esbuild");
    assert!(status.success(), "esbuild failed");
    println!("cargo:rerun-if-changed=host.ts");
}
