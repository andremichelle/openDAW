# Versioned Studio WASM assets

The Studio JavaScript bundle already uses a build UUID. Engine and stretch binaries previously used
stable URLs. A returning browser could load an older cached binary alongside a newer processor, causing
missing host exports or a box registry mismatch after an update.

Use the same build UUID in realtime/offline engine URLs, the stretch URL, the development server mount,
and emitted WASM paths. Keep old build assets available while old pages may still use them.

This change was developed with Codex while testing nested track groups. It is separate from that feature.
Validation includes a production Studio build and browser engine startup with matching versioned files
in the grouping preview. A CDN invalidation alone does not clear a browser's fresh cached binary.
