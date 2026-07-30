---
name: rust-cargo
description: Rust verify defaults for grok-build runs.
---

# Rust (grok-build)

Default verify is `cargo test` at the workspace / crate root. Prefer fixing
compile and test failures the suite already reports over inventing extra tools.
`target/` is a cache and is never committed from an isolated run.
