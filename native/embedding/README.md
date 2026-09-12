# Embedding native runtime

This directory pins the source and patch used to build Lorelum's CPU-only `llama-server`. The platform-specific development candidate remains under the ignored `packages/backend/.artifacts/native/embedding/<target>/` directory. `dist/` is reserved for release staging and archives.

The server's standard input is a parent-liveness pipe. Its independent watcher starts before llama.cpp parses arguments or loads a model. Closing the daemon's write end makes the server call `_Exit`, including when normal inference cleanup cannot make progress. No other component may consume the server's stdin.

The `stalled-main` probe needs the patched llama.cpp source and prepares it in the invoking worktree's `.cache/native-build/` when necessary. It does not rebuild `llama-server` or alter the shared completed-runtime cache.

Build and validate the host's CPU artifact (macOS arm64, Linux x64):

```sh
bun run build:native
bun scripts/native/test-parent-liveness.ts --mode startup
bun scripts/native/test-parent-liveness.ts --mode encoding
bun scripts/native/test-parent-liveness.ts --mode stalled-main
```

Linux builds use the distribution's `cmake` and `c++` (no pinned CMake download); the cache key fingerprints the system CMake, compiler, and glibc versions in place of the macOS SDK. The recipe disables OpenMP so the binary links only the system runtime (`libc`, `libstdc++`, `libm`, `libgcc_s`) and stays portable across distributions with a compatible glibc.

`build:native` keeps downloaded source, CMake, and CMake intermediates in this worktree's ignored `.cache/native-build/`. Its completed runtime is shared through the operating system cache: on macOS, `~/Library/Caches/Lorelum/native/v1`; on Linux, `$XDG_CACHE_HOME/lorelum/native/v1` or `~/.cache/lorelum/native/v1`; on Windows, `%LOCALAPPDATA%\Lorelum\Cache\native\v1`. The first matching build creates a verified cache entry. A later worktree with the same recipe and compiler/SDK fingerprint copies that entry into its own `.artifacts` candidate without downloading or starting CMake. Delete the system cache root to force a rebuild.

The checked-in `packages/backend/src/runtime/native/embedding/darwin-arm64.json` and `linux-x64.json` are the reviewed source recipes and the manifests compiled into a release CLI. A source backend accepts a locally built candidate only when its target, recipe fields, model identity, file hashes, executable mode, and dynamic dependencies validate; its `buildIdentity` may differ because the local compiler produced different bytes. A compiled release requires the on-disk manifest to match the manifest compiled into that CLI exactly. A build never silently updates the checked-in trust anchor. When the recipe changes, review the candidate, run the native and backend integration checks, and explicitly update the trusted manifest before compiling a release.

The macOS CPU target is an M1-compatible ARMv8.4/FP16/dot-product baseline, with no i8mm and no compiled GPU backend. It is verified on M4, not yet on every Apple Silicon device. The Linux x64 CPU target is the generic x86-64 baseline: `GGML_NATIVE` plus `GGML_SSE42/AVX/AVX2/BMI2/FMA/F16C` and `GGML_OPENMP` are all off, so no AVX2/AVX-512 capability is required; the fast CPU variants remain future work. It was built and verified on Ubuntu 24.04 (glibc 2.39) under WSL2, which does not by itself certify every Linux distribution. Windows artifacts and private process/file support remain pending.

Run the backend acceptance separately after the native build:

```sh
bun packages/backend/integration/embedding.integration.ts /absolute/path/to/granite-q4_0.gguf
bun packages/backend/integration/daemon-embedding.integration.ts /absolute/path/to/granite-q4_0.gguf
```

The first script optionally accepts a second argument pointing to the preserved validation reference directory; this also checks frozen tokenizer and Q4 vectors. It performs no model download. The second uses an isolated runtime directory and verifies process reuse, timeout/crash recovery, parent death, and clean daemon restart.

For the four integration entrypoints, scenario boundaries, optional frozen references, and the distinction between acceptance and performance observations, see the [backend integration guide](../../docs/development/backend-integration.md).
