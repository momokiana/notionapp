# Third-party notices

No product license has been selected. The licenses below cover their respective third-party components only; they do not license this project as a whole.

| Component | Frozen direct version | Upstream license |
| --- | --- | --- |
| Fastify | 5.12.7 | MIT |
| better-sqlite3 | 13.0.3 | MIT (SQLite separately follows its upstream public-domain dedication) |
| Pi SDK and fixed Pi subpackages | 1.4.0 | MIT |
| AJV | 8.20.0 | MIT |
| typebox | 1.3.27 | MIT |
| undici (override) | 8.12.2 | MIT |
| UnifiedPush android-connector | 2.4.0 | Apache-2.0 |
| Gradle wrapper | 8.13 | Apache-2.0 |

The Android app preserves its [third-party notices](android/app/src/main/assets/third_party/NOTICES.txt) and [Apache-2.0 text](android/app/src/main/assets/third_party/Apache-2.0.txt). Kotlin, AndroidX and build tools remain subject to their respective licenses. The wrapper launchers preserve their upstream notices.

Exact dependency resolution is in the npm lockfiles and `android/app/gradle.lockfile`. Full dependency license files are supplied by the corresponding package distributions; dependencies, reference-project code, third-party APKs and native binaries are not vendored here. Optional ntfy software tests require a separately verified official 2.34.0 Linux binary, supplied upstream with Apache-2.0; that binary and all runtime configuration are excluded.

These notices are an inventory, not a complete license audit of every transitive package. See [public status](docs/status.md) for dependency security findings and verification limits.
