<p align="center"><img src="logo.svg" width="128" alt="magpie-nest logo"/></p>

<h1 align="center">Magpie Nest · magpie-nest</h1>

<p align="center">One package, sixteen web-session AI channels — one install, sign in per channel</p>

<p align="center"><a href="https://github.com/hongmaple0820/magpie-plugin-pack/actions/workflows/test.yml"><img src="https://github.com/hongmaple0820/magpie-plugin-pack/actions/workflows/test.yml/badge.svg" alt="tests"/></a></p>

This repo (magpie-plugin-pack) publishes a single omnibus package, **`magpie-nest`**: a standard OpenCode v1 plugin package (`config` / `auth` / `provider`) whose entry exports sixteen plugin functions, each run by the host as its own plugin — **one install, sixteen independently signed-in providers**. Multi-account, failover, quota display and auto-update are handled by magpie.

> 中文说明见 [README.md](./README.md)。

## Channels

Everything lives in [plugins/magpie-nest](./plugins/magpie-nest). Each channel's code is in `lib/<id>/` with its own README.

| Provider id | Channel | Sign-in |
| --- | --- | --- |
| `inkstone` | Shusheng Inkstone (Discovery): Orbit Agent + TokenPlan API, credit usage | Windows desktop client import (one click, no browser), or web SSO |
| `lobsterai` | Youdao LobsterAI: 18 models, SSE-only endpoints, daily check-in | Browser login + paste redirect URL |
| `zai-web` | Z.ai web: GLM-5.3 / 5.2 / 5.1 / 5, OpenAI-compatible passthrough | Paste web token (eyJ…) |
| `opencode-free` | OpenCode free anonymous pool: 9 models, no account | One click, no input |
| `glm` | Zhipu ChatGLM web: signed requests + cumulative shard stream | Paste `chatglm_refresh_token` |
| `qwen-ai` | Qwen AI web (chat.qwen.ai): 10 models, session-then-message protocol | Paste web token |
| `perplexity` | Perplexity web: 11 models, SSE differential patch stream | Paste session cookie |
| `kimi-web` | Kimi web: K3 / K2.7-Code / K2.6 / K2.5, gRPC-Web framing | Paste access token |
| `qwen-web` | Tongyi Qianwen web: 9 Qwen3 models | Paste `tongyi_sso_ticket` |
| `doubao` | Doubao web: samantha completion stream | Paste `sessionid` |
| `loomy` | iFlytek Loomy: 8 models, OpenAI-compatible | Paste session token |
| `gemini-code-assist` | Gemini Code Assist: v1internal envelope, 4 tiers | Paste full Google credential JSON |
| `raccoon` | SenseTime Raccoon Work: 6 models, OpenAI-compatible + org code | Paste web access token |
| `agnes` | Agnes AI text models (image/video not implemented) | Paste API key |
| `deepseek-web` | DeepSeek web: sha3 PoW (wasm bundled) + per-turn session + patch stream | Paste token or credential JSON |
| `chatgpt-web` | ChatGPT web (**experimental**): sentinel handshake + local PoW/turnstile + patch stream; may be blocked by TLS fingerprinting | Paste access token or credential JSON |

> ⚠️ All channels are reverse-engineered web protocols, not official APIs: upstream changes can break them at any time, and accounts risk rate limits — don't use a primary account. When a channel id collides with an existing community plugin (`inkstone`/`deepseek-web`/`chatgpt-web`), pick the owner with `magpie plugin use`; this pack never steals a signed-in account.

## Install (one command)

```powershell
git clone https://github.com/hongmaple0820/magpie-plugin-pack.git
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-nest"
```

- Or in the magpie app: Plugins → Add plugin → paste the folder path.
- The repo's `install.ps1` / `install.sh` still work (they walk `plugins/*/`), and are safe to re-run.

Channels you never sign in to simply sit there; they do not affect the others.

## Sign in

Example:

```powershell
magpie plugin login inkstone
magpie provider test inkstone
magpie quota
```

Other channels: see `plugins/magpie-nest/lib/<id>/README.md`.

## Update

Before publishing to npm, updating = `git pull`:

```powershell
cd magpie-plugin-pack
git pull
```

- Terminal CLI: nothing to do, every command loads the folder's current content.
- magpie app: toggle the pack off and on in Plugins → Installed, or restart magpie.

## Tests

One command at the repo root (cross-platform):

```bash
npm test
```

`test/pack-install.test.mjs` is the packaging regression: the entry exports exactly the sixteen plugin functions, and the `files` whitelist installs standalone (including the deepseek wasm asset).

GitHub Actions runs the full suite on **ubuntu + windows** for every push / PR. Zero runtime dependencies, no `npm install` needed.

## Layout

```
magpie-plugin-pack/
├── README.md / README.en.md
├── LICENSE                       # MIT
├── install.ps1 / install.sh
├── scripts/test-all.mjs
├── .github/workflows/test.yml
└── plugins/
    └── magpie-nest/     # the one package: 16 channels
        ├── index.mjs             # exports the 16 plugin functions, nothing else
        ├── lib/<id>/             # per-channel protocol code + README
        ├── assets/               # deepseek-web sha3 wasm
        ├── test/
        └── package.json
```

Rules:

- **The entry module exports plugin functions only**: the host executes every exported function as a plugin, so one stray helper export crashes at load. Helpers live in `lib/<id>/`.
- Zero shared state between channels; a new channel = a new `lib/` dir + one export line + a test.
- The former standalone-plugin layout was folded into this pack (still in git history).

## Publishing (later)

```bash
cd plugins/magpie-nest
npm publish --tag beta
```

Then users install with `magpie plugin add magpie-nest`. A PR to `magpie-community/plugins`'s `registry.json` lists it in the community index.

## License
