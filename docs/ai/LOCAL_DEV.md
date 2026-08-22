# Local Development with the Core Projects — `bun link`

> **Scope**: maintainers and AI agents working across the IgnEX core stack.
> Application developers consume published versions from npm and do **not**
> need this file.

## Why

The IgnEX core packages live side-by-side, one directory back from this repo,
in `/home/adeel/poc/`. When a change in this repo must be tested against the
local source of a core project (or a core change must be tested against this
repo), use `bun link` so the consumer resolves the local directory instead of
the npm registry. This is the supported Bun ≥ 1.4 (Rust-based runtime)
local-development mechanism
([`bun link` docs](https://bun.com/docs/cli/link),
[bun.com/blog/bun-v1.4](https://bun.com/blog/bun-v1.4)).

This workflow is **only for maintainers and AI agents working with the core
projects**. CI and release pipelines always resolve from the registry; local
links are a development-only convenience.

## Core packages (one directory back)

| Repo (`/home/adeel/poc/`) | Package(s) | `bun link` name |
| --- | --- | --- |
| `ignus` — ignex monorepo, workspaces `packages/*` | `@ignex/core`, `@ignex/cli`, `@ignex/compiler`, `@ignex/native`, `@ignex/shared`, `@ignex/mcp`, `@ignex/app`, `create-ignex` | run `bun link` inside each package dir |
| `bun-rust-runtime-bench` | `castrum` (Rust addon `castrum.<platform>-<arch>.node`) | `castrum` |
| `ignex-mongodb` | `@ignex/ninox` | `@ignex/ninox` |
| `ignex-nova` | `@ignex/nova` | `@ignex/nova` |

Known cross-repo edges (verify with `grep` in `package.json` before assuming):

- `@ignex/native` (in `ignus/packages/native`) depends on `castrum` — link
  `castrum` there when changing the addon wire (`createNativeRoute`).
- `@ignex/core` (in `ignus/packages/core`) optionally depends on
  `@ignex/nova`; `@ignex/app` depends on `@ignex/core`, `@ignex/cli`, and
  `@ignex/ninox`.

## How to link

```bash
# 1. Register the core package (once per machine, from the core repo):
cd /home/adeel/poc/ignex-mongodb
bun link            # → Success! Registered "@ignex/ninox"

# 2. Link it into the consumer project:
cd /home/adeel/poc/ignex-app
bun link @ignex/ninox              # symlinks node_modules/@ignex/ninox → ../ignex-mongodb
bun link @ignex/ninox --save       # also writes "link:@ignex/ninox" into package.json deps
```

- `bun link` (no args) in a package directory registers that package globally
  for this user.
- `bun link <name>` in a consumer creates a symlink in the consumer's
  `node_modules` pointing at the registered directory. `--save` additionally
  records `"<name>": "link:<name>"` in `package.json` dependencies.
- Unregister a package: `bun unlink` from the core repo dir.
- Return to registry versions: remove the `link:` entry (or `bun unlink
  <name>` in the consumer) and `bun install`.

## Rust-core caveats (castrum & @ignex/nova)

Both `castrum` and `@ignex/nova` ship a Rust cdylib. After changing Rust
source, rebuild the addon **before** linking or using:

- `castrum`: `bun run build` (release `napi build`) or `bun run build:debug`.
  Under Bun the addon is also called through `bun:ffi` from the same cdylib.
- `@ignex/nova`: `bun run build:rust`
  (`cargo build --release --manifest-path rust/Cargo.toml`), or rely on
  `prepack`/`prebuild` to stage `prebuilds/<platform>-<arch>/`.

A stale `.node`/`.so` silently serves old behavior — rebuild, then re-test.
`@ignex/nova` additionally fails its bind-time self-test on schema/wire-version
mismatch (`IGNEX_FFI_PATH` can point at a specific build); `castrum` falls back
to the napi transport when the `bun:ffi` self-test fails.

## Never publish from a linked tree

Publishing a consumer whose dependencies are `link:` entries ships symlinks,
not packages. Releases always run against registry versions (`prepublishOnly` /
CI re-verify with a clean install). Keep `bun link` strictly local.
