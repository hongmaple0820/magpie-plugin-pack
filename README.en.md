# magpie-plugin-pack

A collection of **magpie / OpenCode provider plugins**. Every plugin is a standard OpenCode v1 plugin (`config` / `auth` / `provider`) and works in magpie out of the box: multiple accounts, failover, quota display and auto-update are all handled by magpie.

> 中文说明见 [README.md](./README.md)。

## Plugins

| Plugin | Provider id | What it does | Sign-in | Folder |
| --- | --- | --- | --- | --- |
| magpie-inkstone-auth | `inkstone` | Shusheng Inkstone (Discovery) cloud models: Orbit Agent + TokenPlan API dual channel, credit usage | Windows: one-click import from the local Inkstone desktop client (no browser, nothing to type), or web SSO | [plugins/magpie-inkstone-auth](./plugins/magpie-inkstone-auth) |

> New plugins go into `plugins/<name>/` and get a row in the table above.

## Install all plugins in one shot

### Windows (PowerShell 5.1+)

```powershell
git clone https://github.com/hongmaple0820/magpie-plugin-pack.git
cd magpie-plugin-pack
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

If `magpie` is not on PATH:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Magpie "D:\Program Files\magpie-windows-amd64.exe"
```

### macOS / Linux

```bash
git clone https://github.com/hongmaple0820/magpie-plugin-pack.git
cd magpie-plugin-pack
./install.sh
# custom magpie path: MAGPIE=/path/to/magpie ./install.sh
```

The script simply walks `plugins/*/package.json` and runs `magpie plugin add <absolute path>` for each one. Running it again is safe (magpie rejects entries that are already added).

## Install a single plugin (manual)

magpie loads a folder in place without installing anything, which is the most convenient option before publishing to npm:

```powershell
magpie plugin add "F:\path\to\magpie-plugin-pack\plugins\magpie-inkstone-auth"
```

Or in the magpie app: Plugins → Add plugin → paste that folder path.

Then enable the plugin in Plugins → Installed and sign in.

## Sign in

For inkstone:

```powershell
magpie plugin login inkstone     # choose "Import from local Inkstone client" (Windows, no browser, nothing to type)
magpie provider test inkstone    # send a tiny request for each API
magpie quota                     # view credits and 5h/7d windows
magpie plugin                    # list plugins / accounts / models
```

See each plugin's own README for details.

## Updating

Before npm: updating means `git pull`.

```powershell
cd magpie-plugin-pack
git pull
```

- CLI: nothing else needed — every command loads the folder's current contents.
- App (GUI): toggle the plugin off and on in Plugins → Installed, or restart magpie.

## Testing

One command at the repo root runs every plugin's tests (cross-platform):

```bash
npm test
# equivalent to node scripts/test-all.mjs — walks plugins/*/package.json and runs each npm test
```

GitHub Actions ([.github/workflows/test.yml](./.github/workflows/test.yml)) runs all plugin tests on **ubuntu + windows** on every push / PR. Plugins have zero runtime dependencies, so no `npm install` is needed.

## Layout

```
magpie-plugin-pack/
├── README.md / README.en.md      # docs (this file)
├── LICENSE                       # MIT
├── install.ps1 / install.sh      # one-shot installer
├── scripts/test-all.mjs          # cross-platform test runner
├── .github/workflows/test.yml    # CI: push/PR tests on both platforms
└── plugins/
    └── magpie-inkstone-auth/     # one folder per plugin, with its own package.json + README
```

Conventions:

- One plugin = one folder under `plugins/`, folder name = npm package name.
- The entry is resolved like magpie does (`exports["./server"]` → `main` → `exports["."]` → `index.ts/.tsx/.js/.mjs/.cjs`).
- The entry module exports only the plugin function; keep helpers in `lib/` or use `export default { id, server }`.

## Publishing (later, to npm)

This is a monorepo; each `plugins/<name>/` is published independently:

```bash
cd plugins/magpie-inkstone-auth
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm pack --dry-run
npm publish --tag beta
```

After publishing, users can simply:

```
magpie plugin add magpie-inkstone-auth
```

To appear in the magpie community list, open a PR to `magpie-community/plugins` `registry.json` (see magpie's "Publishing" docs).

## License

[MIT](./LICENSE)
