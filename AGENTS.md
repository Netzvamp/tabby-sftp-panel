# AGENTS.md

> Keep this file current. When you change the build, the module wiring, a hard-won
> Tabby internal, or the dev/test/deploy flow, update the relevant section in the
> same commit. This is the fast-start map for the next agent — stale = worse than
> missing.

## What this is

`tabby-sftp-panel` — a **standalone** SFTP panel plugin for [Tabby](https://github.com/Eugeny/tabby)
(Electron terminal). It mounts its own Angular 15 component into each SSH tab — and,
backed by the local filesystem instead of SFTP, each local terminal tab — and reuses
Tabby's services via DI. It does **not** patch Tabby's built-in SFTP panel — the two
coexist, which is what makes it publishable.

Config key: `sftpPanel`. **No titlebar button** — the panel is a permanent
collapsed edge strip (24px) on every SSH pane, and (gated on `localTabs`, on by default)
every local terminal pane too, that expands on hover. `pinned` = docked (reserves width,
terminal shrinks); unpinned = strip that overlays the terminal on hover. Hotkey
`toggle-sftp-panel` ("Focus SFTP Panel") reveals + focuses the active pane's panel; Esc
collapses a hover-opened one.

## Layout

```
src/
  index.ts            NgModule — wires 4 providers (Config/SettingsTab/ToolbarButton/Hotkey),
                      declares panel + settings + ChmodDialog + CopyMoveDialog; imports
                      CommonModule/FormsModule/NgbModule/TabbyCoreModule
  config.ts           sftpPanel defaults — side, pinned, width, startDirectory, showHidden,
                      fileClickAction, editorEnabled/editorPath/editorMaxSizeMB, sort, columns,
                      columnOrder, transfersVisible/transfersHeight/transfersAutoShow, localTabs
                      (also mount the panel on local terminal tabs; on by default), wslTabs (on a
                      WSL tab, browse that distro filesystem instead; on by default)
  panel.component.ts  SftpPanelComponent — the panel UI (inline template+styles). The big one.
  mount.service.ts    PanelMountService — dynamic createComponent() into each SSH pane's DOM,
                      and each local terminal pane's (`tab.profile?.type === 'local'`, gated on
                      config `localTabs`); collapsed 24px edge strip + hover-expand, pin/dock vs
                      overlay, Esc-collapse, per-pane in split tabs, startup-restored splits
                      (initialized$), teardown
  log.service.ts      LogService (providedIn:root) — unified panel log: file transfers (Tabby's
                      platform stream) + messages (chmod/copy/move failures, notices); render-lag
                      fix, folder-upload aggregation, Stop-button cancel, hides Tabby's popup
  local-edit.service.ts  LocalEditService (providedIn:root) — "edit locally": download→temp, spawn
                      editor (configured exe or OS default), fs.watch → debounced re-upload + chmod;
                      one temp copy per server+path (reopen reuses it, offers reload when the remote
                      moved); edits outlive their session (temp copies die only on window unload); a
                      save with no live handle offers to reopen a tab to that server;
                      Windows .txt-handler auto-detect (UserChoice registry) for settings prefill
  toolbar.ts          SftpPanelHotkeyProvider (declares toggle-sftp-panel) + SftpPanelBootstrap
                      (no visible button; bootstraps mount service + i18n + wires hotkey → focusPanel)
  i18n.service.ts     SftpI18nService (providedIn:root) — merges locale/<lang>.po into Tabby's live
                      ngx-translate catalog (setTranslation merge=true) on init + LocaleService
                      .localeChanged$. Only ships strings Tabby lacks; shared labels reuse Tabby's.
../locale/*.po      our gettext catalogs — at the REPO ROOT, not under src/ (de-DE, zh-CN,
                      ru-RU, es-ES, fr-FR, ja-JP, pt-BR).
                      gap strings only, 124 msgid each, identical key sets. built via json-loader +
                      po-gettext-loader (webpack .po rule) — same chain Tabby uses. i18n.service
                      picks up new langs automatically (dynamic require → webpack context).
  settings.ts         settings tab for sftpPanel
  chmod-dialog.component.ts     ChmodDialogComponent — permissions (rwx grid) + owner/group modal
  copy-move-dialog.component.ts CopyMoveDialogComponent — destination input + Copy/Move buttons
  local-path.ts       virtual posix ↔ native path conversion (`/C:/Users/x` ↔ `C:\Users\x`),
                      drive-root enumeration + `isDriveRoot`, and `toNativeFsPath` — the guarded
                      conversion EVERY fs call must use; pure, `window`-free so `node:test`
                      can import it
  wsl.ts              WSL detection + distro lookup: profile command/args -> distro (or '' for the
                      default), one cached `reg.exe query …\Lxss /s` for the default distro name
                      and each DefaultUid, `\\wsl$\<distro>` as the base, and `wslHome` resolving
                      the distro home from its own /etc/passwd. Parsers are pure; reg.exe messages
                      are localized but its data lines are not, so parsing goes by structure
  local-fs.session.ts `LocalFsSession`, duck-types `SFTPSession` over node `fs` so the panel
                      browses a local tab with no call-site changes; streams `upload`/`download`
                      through the same transfer interface
  local-ops.ts        `localCopy`/`localMove`/`localTrash`/`localExists`/`localRefusal` — the ops
                      a local tab does differently: `fs.cp` copy, rename-with-EXDEV-fallback move,
                      recycle-bin delete via Electron `shell.trashItem`, and an existence check
                      the panel uses to gate a same-name overwrite behind a confirm prompt.
                      Overwrite means REPLACE (destination goes to the RECYCLE BIN first, files
                      and dirs alike); `localRefusal` reports up front, before any removal and
                      before the prompt, everything that cannot work: drive roots, a vanished
                      source, same-entry (dev+ino) and either endpoint nested inside the other
  sftp-util.ts        pure helpers — file type/icon/mode, sort/filter, sizes/times, perms
                      (octalToPerms/permsToOctal), owners (parseLsOwners/parseNames), log
                      (LogEntry/logFullText/computeLogSelection), start-path (resolveStartPath),
                      columns (moveColumn), editor (parseFtypeExe/isBigFile), server-side cp/mv
                      (shQuote/buildCpCommand/expandDirs), local-tab column/sort gating
                      (filterLocalCols/effectiveSortColumn)
  logic.ts            dock math (clampSize/dockSize) — clampSize reused for transfer-list height
  *.test.ts           node:test units for sftp-util (32) + logic (4) + i18n (2) + local-path (13)
                      + local-fs.session (13) + local-ops (32) + wsl (9) = 105
                      i18n.test.ts guards the catalogs: identical msgid sets, no empty msgstr
docs/superpowers/      specs + plans (design of record)
_tabby-ref/            full Tabby source, READ-ONLY reference. NOT ours. Ignore in globs.
```

`_tabby-ref` is ~14k files — always scope globs to `src/**` / `docs/**` or it drowns you.

## Build / test / verify

**Run `npm run build` after every code change.** Webpack emits `dist/index.js`; Tabby
loads the built file, not the source.

```
npm run build      # webpack → dist/index.js
npm run watch      # rebuild on change
npm test           # tsx --test src/*.test.ts — 105 units (sftp-util 32 + logic 4 + i18n 2 +
                    # local-path 13 + local-fs.session 13 + local-ops 32 + wsl 9)
npx tsc --noEmit -p tsconfig.json   # REQUIRED type-check — build does NOT type-check
```

`src/package.json` (`{"type": "module"}`) scopes ESM module resolution to everything under
`src/` — it exists only so `*.test.ts` files can use a top-level `await` (e.g. shimming
`window.require` before a dynamic `import()` of the module under test); esbuild (via `tsx`)
cannot emit top-level await when the resolved output format is CommonJS, which is what the
untyped root `package.json` defaults to. The root `package.json` deliberately stays untyped:
`webpack.config.js` uses `require`/`module.exports` and the built `dist/index.js` is UMD,
loaded by Tabby via `require()` — flipping the root to ESM would break both. `files: ["dist"]`
keeps `src/package.json` out of the published tarball (verify with `npm pack --dry-run`).

**Build gate blind spot:** webpack uses `ts-loader { transpileOnly: true }` → no type
check, no AOT template compile (Ivy runs JIT at runtime). A green `npm run build`
catches **neither** type errors **nor** template/module-scope errors (a missing pipe or
directive throws only at first render, e.g. `NG0302`). `tsc --noEmit` closes the type
half; nothing closes the template half — those surface only when the panel renders in a
running Tabby. CI (`.github/workflows/ci.yml`) runs `npm ci` + `tsc --noEmit` + `npm test`
+ `npm run build` on every push to main and every PR.

Windows: `npm install` needs `.npmrc` `ignore-scripts=true` (tabby-ssh postinstall has
no win32 script; deps are webpack-externalized so install scripts are unneeded anyway).

**`npm audit` noise is expected — do NOT "fix" it.** The package has zero `dependencies`
(only dev + peer), so `npm audit --omit=dev` reports 0 — nothing vulnerable ever reaches
a user, who gets only the bundled `dist/index.js`. The ~18 dev-only findings come from
versions Tabby pins for us: `@babel/core` + Angular via `@ng-bootstrap@14 → @angular/localize@15`,
and `@luminati-io/socksv5` via `tabby-ssh`. `npm audit fix --force` would install
`@ng-bootstrap@21`, i.e. Angular-21 typings against Tabby's Angular-15 runtime — and
`transpileOnly` means the build stays green while the panel breaks at first render.

## Dev deploy (load into Tabby)

Junction the repo into Tabby's plugin dir, then **fully restart** Tabby (plugins scan
only at startup — reload is not enough):

```
%APPDATA%\tabby\plugins\node_modules\tabby-sftp-panel  ->  this repo
New-Item -ItemType Junction  (plain symlinks can vanish; junction needs no admin)
```

`package.json` MUST keep an `author` field and `keywords: ["tabby-plugin"]`, else
Tabby's loader throws in `parsePluginInfo` and silently drops the plugin (no log).

Debug: `fs` works in Tabby's renderer (nodeIntegration on) → file-based logging is
handy because the terminal swallows Ctrl+Shift+I/R; open DevTools via Command Palette.

## Publish (appear in Tabby's plugin manager)

The manager (`tabby-plugin-manager/src/services/pluginManager.service.ts`) hits
`registry.npmjs.com/-/v1/search?text=keywords:tabby-plugin` and then keeps only packages
whose npm name starts with `tabby-`. So discovery needs exactly: npm name `tabby-*` +
`keywords: ["tabby-plugin"]` + `author`. It reads `description`, `version`, `homepage`,
`author` straight off the registry — no README rendering, so README image paths must be
absolute URLs (raw.githubusercontent) since `files: ["dist"]` keeps `screenshots/` out of
the tarball.

### Cutting a release

**Never run `npm publish` by hand.** CI owns publishing. A release is a tag push:

```
npm version patch|minor|major   # bumps package.json, commits, tags vX.Y.Z
git push --follow-tags          # tag push triggers .github/workflows/publish.yml
```

`.github/workflows/publish.yml` runs on `push: tags: ['v*']` → `npm ci`, `tsc --noEmit`,
`npm test`, `npm run build`, `npm publish --provenance`. Auth is **trusted publishing**
(OIDC, `id-token: write`) — the npm package's Settings → Trusted Publisher is wired to
this repo + `publish.yml`. No npm token exists anywhere; don't add one, and don't rename
the workflow file (npm matches it by exact filename or rejects the OIDC token).

Verify after: `npm view tabby-sftp-panel version`. Re-running a tag is harmless — npm
refuses to overwrite an existing version (`E403 cannot publish over existing version`).

**`.npmrc` `ignore-scripts=true` suppresses OUR OWN lifecycle scripts too** — a
`prepublishOnly: npm run build` silently never runs and you ship a stale `dist/`. That's
why the workflow builds explicitly. Same trap for any future pre/post script.

`files: ["dist"]` beats `.gitignore` (dist is git-ignored but ships) — verify with
`npm pack --dry-run`. The manager shows the highest semver of a name; installs run
`npm install <pkg>@<version>` into `userPluginsPath`.

npm killed TOTP enrollment (Sept 2025) and revoked classic tokens (Dec 2025). Interactive
publishing now needs a passkey/WebAuthn; that's the fallback if CI is ever broken.

## Tabby internals that bite (verified against source)

- **i18n reuses Tabby's catalog.** Tabby's `LocaleService` loads each `locale/<lang>.po` into
  ngx-translate ONCE (guarded), replacing that lang's map, then emits `localeChanged$`. We merge
  our own strings on top with `translate.setTranslation(lang, dict, /*merge*/true)` — so our .po
  ships ONLY the strings Tabby lacks (shared labels like Copy/Download/Delete/Cancel/Edit
  locally/Name/Group/Left/Right/Clear/Create directory/File transfers resolve from Tabby's .po
  free — do NOT re-translate them). Interpolate with MessageFormat `{var}` (Tabby uses
  TranslateMessageFormatCompiler): `translate.instant('Deleting {name}…', {name})`. Gotchas: (1)
  an apostrophe in a msgid is an MF escape char and mangles the English fallback — reword the
  source string to avoid `'`. (2) Dialog button arrays that double as `switch` keys must keep an
  untranslated key array for logic and translate only the display labels. (3) `translate` pipe is
  in scope via TabbyCoreModule (re-exports TranslateModule) — but that's template-scope, which
  no build step or test verifies. (4) **Merge-after-render refresh:** panels mount before
  our merge runs, so their pipes cache the English key. `setTranslation` only emits
  `onTranslationChange`, whose pipe handler is gated on `currentLang` — but Tabby sets only
  `defaultLang` (currentLang stays undefined), so pipes ignore it and show English until unrelated
  change detection re-runs. i18n.service fixes this by emitting `onDefaultLangChange` after each
  merge (no currentLang gate → all live pipes re-evaluate now).
- **DI works without hacks.** Webpack externalizes `/^tabby-/`, `/^@angular\//`,
  `/^@ng-bootstrap\//`, and `rxjs`, so token identity matches Tabby's running instances.
  `createComponent(Comp, {
  environmentInjector: <root>, hostElement })` + `appRef.attachView` mounts an
  NgModule-declared component into a tab's DOM. `@Optional() @Inject(SFTPContextMenuItemProvider)` resolves fine.
- **Runtime classes not in typings** (e.g. anything you must `require`): use Electron's
  `(window as any).require('tabby-ssh').X` — bare `import` from a junctioned plugin
  resolves to the plugin's OWN node_modules copy (wrong object), not Tabby's live class.
- **SSH tab:** `tab.sshSession` = live SSHSession (`.session` = shell session). Host el
  `tab.element.nativeElement`; terminal host = its `.content` child (set margin there to
  shrink terminal — Tabby's ResizeObserver refits xterm, no manual refit). `tab.destroyed$`.
  Split tabs: `app.activeTab.getFocusedTab()`.
- **`SFTPSession.stat()` is NOT a usable metadata source.** russh fills in `size` but leaves
  `permissions` and `mtime` empty, so tabby-ssh maps them to `mode: 0` and
  `modified: new Date(0)` — silently, no error. Verified against a real server: `stat()` on a
  0644 file returns `{size: 9, mode: 0, modified: 1970-01-01}`. Consequences if you trust it:
  passing that mode to `sftp.chmod()` sets the remote file to `0000`, and passing it to
  `startDownload()` marks the local file read-only on Windows (the next download then cannot
  overwrite it). `readdir()` DOES carry complete metadata (`entry.metadata.permissions/.mtime`),
  which is why the panel's Modified/Permissions columns are correct. **Get fresh metadata by
  reading the parent directory and picking the entry out** — that is what `freshMeta()` does in
  both panel.component.ts and local-edit.service.ts. Note readdir's `mode` includes the file-type
  bits (0o100644 = 33188), same as everywhere else in the panel.
- **`| filesize` pipe is NOT in scope** for a plugin importing TabbyCoreModule (NgxFilesize
  is imported by AppModule, not re-exported) → `NG0302` at render. Use `formatSize()` in sftp-util.
- **Create-dir modal:** tabby-ssh does NOT export `SFTPCreateDirectoryModalComponent`.
  Use tabby-core's exported `PromptModalComponent`.
- **Context-menu contract:** a custom panel passed as `panel` to `getItems(item, panel)`
  must expose `sftp / path / navigate / openCreateDirectoryModal / downloadFolder /
  downloadItem` (downloadItem is easy to forget). "Edit locally" = `EditSFTPContextMenu`
  (tabby-electron, Electron-only); invoke via the menu item's `.click()`.
- **`startDownloadDirectory`** is on the electron PlatformService at runtime but absent
  from typings → cast `(platform as any)`.
- **Transfer UI render lag (fixed):** Tabby's appRoot updates its transfer list from russh
  SFTP callbacks that run OUTSIDE Angular's zone → no change detection → entries render
  10-20s late when backgrounded. `LogService` (unified log: transfers + panel messages) subs
  `PlatformService.fileTransferStarted$` itself and forces `cdr.detectChanges()` (via a `changed$`
  the panel subscribes to). A 300ms poll (only while a transfer is active) samples `isComplete()`
  since there's no completion event. `transfer instanceof FileUpload` gives direction (external
  tabby-core value import → runtime class). Auto-show is driven off this stream (edit-locally
  re-uploads bypass our upload/download methods). Hides Tabby's own popup via
  `body.sftp-panel-hide-tabby-transfers` → CSS hides `transfers-menu` +
  `button.btn-tab-bar.dropdown-toggle`.
- **Folder-upload aggregation:** a folder drag/upload makes tabby-ssh emit one platform
  transfer PER descendant file during discovery (getAllFiles / traverseFileTree). `LogService`
  `beginCapture()`/`endCapture()` stash those, show one live "Scanning folder…" row, then the
  panel renders a single aggregate row (`dropTransfers` the children without cancelling +
  `addTransfer` the aggregate). `swapTransfer` repoints a row to a cancellable proxy so the
  log-line Stop button actually aborts an in-flight transfer.
- **Local tabs and path flavour.** The panel imports `posix as path`, and `posix.resolve('C:/a/b',
  '..')` does not recognise `C:/` as a root — it prepends `process.cwd()` and returns garbage. So
  `LocalFsSession` presents *virtual* posix paths (`/C:/Users/x`) and converts to native only at
  the fs boundary; `/` is a synthetic root whose listing is the drive list (probe `A:\`…`Z:\` with
  `existsSync` — no `wmic`). **`toNativePath` relativises anything not rooted at a drive**
  (`/foo` → `foo`, and UNC flattens to the same shape), which every `fs` call would then resolve
  against Tabby's own cwd, i.e. write into the install directory — so every fs boundary uses
  `toNativeFsPath`, which throws instead. Two rows/paths are navigable and NOTHING else, guarded in
  the panel and backstopped in `local-ops.ts`: the virtual root (`atVirtualRoot()` hides create
  file/dir and ignores drops — you cannot create "in" a drive list) and a drive row (`isDriveRoot`,
  because `win32.basename('C:\\')` is `''`, so `join(dest, '')` is `dest` and a "copy C:" would
  clone the whole drive over it). **`setSession` resets `this.path` when the swap crosses the
  local/remote boundary** (mixed splits): the same-flavour reconnect deliberately restores its
  folder, but carrying `/home/rob` from an SSH pane onto the local filesystem silently shows a
  different, identical-looking directory. A local pane is detected by `tab.profile?.type === 'local'` and handed
  a **stable** wrapper object (cached per pane in a `WeakMap`): `setSession()` treats a different
  object as a reconnect and drops the open handle, so a fresh wrapper per focus change would reopen
  the listing every time. Local sessions have no `shell` field, so `openIfReady`'s shell-channel
  wait must be skipped or it burns its full 5s cap before the panel works. Everything reached
  through `exec()` (home resolve, `ls -l` owners, root detect, chown) degrades on its own —
  `exec()` returns `null` without an `ssh` object. **Local overwrite confirm is one-sided:** before
  a local-tab copy/move overwrites a same-named destination, `local-ops.ts`'s `localExists()` gates
  a confirm prompt (overwrite / skip / cancel, asked once per colliding item — no "apply to all",
  see `confirmLocalOverwrite` in panel.component.ts) and **"Overwrite" means REPLACE** — local-ops
  removes the destination first, because `fs.rename` cannot replace a non-empty directory
  (EPERM on win32, ENOTEMPTY on posix) and `fs.cp {recursive, force}` MERGES into one; the
  prompt's wording cannot say "merge" without a new msgid in all seven catalogs. Three rules hang
  off that removal, all of them paid for in blood: (1) it goes through the **recycle bin**
  (`shell.trashItem`, the same call `localTrash` uses) — consenting to Overwrite is not consent to
  a permanent delete, and a bin that fails is reported, never downgraded to `fs.rm`; (2) same-entry
  is detected by **`fs.stat` dev+ino, never by comparing resolved path strings** — `path.win32
  .resolve` preserves case, so on a case-insensitive volume (Windows, macOS by default) a
  case-different spelling of the folder an item already sits in compares unequal while naming the
  same file, and the removal would then bin the SOURCE (`fs.cp`'s own dev+ino check used to catch
  this, but the removal now runs first); NESTING has to be refused in BOTH directions by `nests()`
  — a directory copied into its own subtree (`b` → `b/c/b`, which `fs.cp` at least refuses itself
  with `ERR_FS_CP_EINVAL`) and the mirror, a destination that is an ANCESTOR of the source
  (flattening `src/src` into `…/`, where the path about to be binned CONTAINS the source, and where
  raw `fs.cp` SUCCEEDS so there is no backstop but ours). Each direction runs a `nodePath.relative`
  pass (`win32.relative` folds case, `posix.relative` does not) plus a dev+ino walk of the inner
  path's existing ancestors (the pass that survives macOS's case-insensitive default volume and a
  symlinked destination). The ordinary move UP one level — into the parent of the directory the item
  sits in — must keep working: `to` lands beside that directory, nested neither way. (Into the
  directory it already sits in, `to === from`: a no-op, refused as same-entry.)
  Everything that can refuse runs BEFORE the collision
  prompt, via the exported `localRefusal()`, so a doomed operation is never dressed up as an
  overwrite to confirm, and before the removal, so it never bins for an operation that cannot run;
  (3) a copy/rename that fails after the removal (EBUSY/EACCES on a locked file is routine on
  Windows) says the destination is already in the bin — including the EXDEV leg — since a raw errno
  leaves the user with a vanished folder and no idea where it went; and `clearDestination` treats an
  already-missing destination as already cleared (`fs.rm{force}` no-oped, `trashItem` rejects, and
  the window between the check and the removal contains a modal dialog — only ENOENT counts as
  already-cleared, since treating an EACCES as one would downgrade the overwrite to an `fs.cp`
  merge). Every DESTINATION-side check (`localExists`, `sameEntry`'s `to` stat, `clearDestination`)
  must keep using the SAME stat flavour (`stat`, not `lstat`) — a dangling symlink there is safe
  only because all three fail on it identically; the SOURCE-side bail is the one deliberate
  exception (`stat ?? lstat`), because a broken link is a real, selectable, copyable row and
  `stat` alone reported it as "no longer exists". The SSH path
  (`sftp.rename`, server-side cp/mv)
  deliberately still overwrites silently, as it always has — don't "fix" that asymmetry without
  checking the deferred-decisions note first. **Column/sort gating is view-only:** `filterLocalCols`
  and `effectiveSortColumn` in `sftp-util.ts` are the single source of truth for which columns a
  local tab shows (owner/group hidden everywhere, permissions posix-only) and which column it
  actually sorts by; the sort coercion (owner/group → name) happens at the view layer and is never
  written back to config, so an SSH tab elsewhere keeps its own owner/group sort untouched.
  **Virtual paths never reach the user:** anything shown or prefilled on a local tab goes through
  `displayPath()`/`toNativePath` (Copy path, both overwrite prompts, the Copy/Move destination
  field, copy/move log lines), and the dialog's answer is converted back with `toVirtualPath`
  (idempotent, so a typed virtual path still works). The drag-in collision prompt reuses the
  copy/move msgid `'{target} already exists.'` locally — `'…on the server.'` is remote-only.
- **What the local destructive paths still cannot promise (accepted at v0.2.0, verified by
  reading, not by test).** Three limits sit under everything above, and none of them is a bug to
  go fix — they are the edges of what the platform gives us. (1) **The recycle bin is the OS's
  promise, not ours.** On win32 `shell.trashItem` goes through `IFileOperation`, which may delete
  PERMANENTLY on a network share or when the item exceeds the bin quota. That applies to Delete
  and, since Overwrite routes through the same call, to Overwrite. Nothing in our code downgrades
  it — the OS does. (2) **Two branches have no test.** The EXDEV leg (a cross-device move, needs
  two volumes) and the non-ENOENT stat in `clearDestination` (needs a permission change *during*
  the modal) are asserted by reading only. `shell.trashItem` is stubbed under `node:test`, so no
  test exercises a real bin either — the stub rejects on a missing path so the TOCTOU case is at
  least visible. Treat all three as unproven when changing that code. (3) **dev+ino assumes real
  inodes.** On a volume that reports `ino === 0` for every entry (exFAT, FAT32, some network
  shares) every existing destination compares identical and every overwrite is refused. That fails
  loudly with no data loss, and matches what node's own `fs.cp` does, so it is the right trade —
  do not "fix" it by guarding on `ino !== 0`, which buys the false-negative direction instead.
  Also note `endpoints()` runs up to two ancestor walks and the panel calls it up to three times
  per item; under a dead network mount each of those stats blocks until the OS times out.
- **WSL tabs are local tabs, and their filesystem is a network share.** `profile.type` is
  `local` and the command is `wsl.exe`; `Shell.fsBase` exists in tabby-local's API but
  `optionsFromShell` never copies it into the profile and the default-distro shell never sets
  it, so the distro comes from the `-d` argument or from the Lxss registry key. The share is
  `\\wsl$\<distro>` for WSL1 and WSL2 alike. **`wslDistroOf` matches `wsl.exe` by basename but
  `bash.exe` only under `%windir%\System32` (or `Sysnative`)** — Tabby ships three other
  built-in local shells whose command basename is `bash.exe` (`gitBash.ts`, `cygwin64.ts`,
  `cygwin32.ts`), and matching those handed a Git Bash tab the default distro's share, wrong
  filesystem and permanent deletes included. Only the System32 one is legacy "Bash on Windows".
  The base is also part of a session's **flavour**: `setSession` resets `this.path` when the
  base changes, not just when `local` does, because two local panes in one split can be two
  different distributions where the same path exists on both. With a base set, `LocalFsSession`
  and `local-ops` speak the distribution's own posix paths and `displayPath` is the identity —
  the `\\wsl$` form is never *deliberately* shown, only handed to `fs` and to an external
  editor, though it can still surface inside a raw fs error message (`local-ops` returns node's
  errno text verbatim and the panel logs it on a copy/move/delete failure). **Everything the 9p
  redirector gets wrong is load-bearing:** `stat().mode` is always `100666`/`40666` and `chmod`
  silently does nothing (harmless — perms and chmod are already hidden on win32); `lstat`,
  `stat`, `readlink` AND `readdir` all throw `ENOENT`/`EISDIR` on a symlink while
  `readdir({withFileTypes:true})` flags it correctly, which is why `entry()` synthesises a
  metadata-less row from the dirent instead of dropping it, and why symlinks can be seen but
  never opened; `stat().dev` is always `0`, so dev+ino identity holds only within one
  filesystem — `/mnt/c/…` and `/home/…` share `dev = 0` and a colliding inode there refuses a
  copy that would have been fine (loud, no data loss, same trade as `ino === 0`); and `\\wsl$`
  itself is not enumerable, so there is no way to discover distros from the filesystem. There
  is also **no recycle bin**: Delete and Overwrite are permanent on a WSL tab, which is why
  both prompts say so and why `localTrash`/`clearDestination` branch on the base rather than
  calling `shell.trashItem`. That coupling is deliberate — base implies WSL implies no bin;
  a second base kind with a bin would need its own flag. **Neither `fs.rm` branch passes
  `force`**: `fs.rm` starts with an `lstat`, 9p throws on `lstat` of a symlink, and `force`
  would turn "could not remove it" into a reported success — a confirmed permanent delete that
  deleted nothing. In `clearDestination` a `stat` has already proven the entry exists, so
  dropping `force` there cannot invent a failure and makes a silent no-op impossible.

## Status

Shipping. Published on npm (`tabby-sftp-panel`), listed in Tabby's plugin manager. On main:

- Standalone panel as a collapsed edge strip that expands on hover; pin to dock (terminal
  shrinks) vs overlay; per-pane in split tabs incl. startup-restored splits; Esc-collapse;
  hotkey focus.
- Right-click context menu (Tabby's SFTP menu + our items), filter, sortable/reorderable/
  resizable columns (name/size/modified/owner/group/perms), configurable start directory,
  show-hidden toggle.
- Embedded unified log/transfer list (toggle, draggable+persisted height, render-lag fix,
  folder-upload aggregation, per-line Stop, hides Tabby's popup, auto-show on transfer).
- chmod/chown dialog, copy/move to a destination on the server, and "edit locally" with a
  configurable editor (or OS default) + auto re-upload on save.
- Edited files are tracked in `LocalEditService.openEdits`, keyed by server (`user@host:port`)
  plus remote path: temp copies are dropped only when Tabby's window unloads — the record, the
  temp file and the watcher all survive a tab closing or the connection dropping. A save resolves
  its SFTP handle from a live-session registry; when none is live it offers to open a new tab to
  that server and then uploads once the handle registers. Re-opening a checked-out file reuses its
  temp copy instead of downloading a second one, and offers a reload when the remote copy moved
  since our last transfer. A re-upload whose remote mtime moved since the last transfer prompts
  before overwriting, and a failed re-upload still raises a modal naming the temp path. Still open
  in issue #5: no polling (detection happens on save and on re-open), and no "keep both" conflict
  option.
- The panel also runs on local terminal tabs as a plain file explorer (`localTabs`, on by
  default), backed by the local filesystem; on a WSL tab it browses that distribution instead
  (`wslTabs`, on by default, setting shown only on win32). Upload/download affordances and the
  owner/group columns are hidden there, chmod is posix-only, delete goes to the recycle bin —
  except on WSL, where there is none and it is permanent — and "edit locally" becomes a direct
  editor spawn with no temp copy.
