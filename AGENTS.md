# AGENTS.md

> Keep this file current. When you change the build, the module wiring, a hard-won
> Tabby internal, or the dev/test/deploy flow, update the relevant section in the
> same commit. This is the fast-start map for the next agent — stale = worse than
> missing.

## What this is

`tabby-sftp-panel` — a **standalone** SFTP panel plugin for [Tabby](https://github.com/Eugeny/tabby)
(Electron terminal). It mounts its own Angular 15 component into each SSH tab and
reuses Tabby's services via DI. It does **not** patch Tabby's built-in SFTP panel —
the two coexist, which is what makes it publishable.

Config key: `sftpPanel`. **No titlebar button** — the panel is a permanent
collapsed edge strip (24px) on every SSH pane that expands on hover. `pinned` = docked
(reserves width, terminal shrinks); unpinned = strip that overlays the terminal on hover.
Hotkey `toggle-sftp-panel` ("Focus SFTP Panel") reveals + focuses the active pane's panel;
Esc collapses a hover-opened one.

## Layout

```
src/
  index.ts            NgModule — wires 4 providers (Config/SettingsTab/ToolbarButton/Hotkey),
                      declares panel + settings + ChmodDialog + CopyMoveDialog; imports
                      CommonModule/FormsModule/NgbModule/TabbyCoreModule
  config.ts           sftpPanel defaults — side, pinned, width, startDirectory, showHidden,
                      fileClickAction, editorEnabled/editorPath/editorMaxSizeMB, sort, columns,
                      columnOrder, transfersVisible/transfersHeight/transfersAutoShow
  panel.component.ts  SftpPanelComponent — the panel UI (inline template+styles). The big one.
  mount.service.ts    PanelMountService — dynamic createComponent() into each SSH pane's DOM;
                      collapsed 24px edge strip + hover-expand, pin/dock vs overlay, Esc-collapse,
                      per-pane in split tabs, startup-restored splits (initialized$), teardown
  log.service.ts      LogService (providedIn:root) — unified panel log: file transfers (Tabby's
                      platform stream) + messages (chmod/copy/move failures, notices); render-lag
                      fix, folder-upload aggregation, Stop-button cancel, hides Tabby's popup
  local-edit.service.ts  LocalEditService (providedIn:root) — "edit locally": download→temp, spawn
                      editor (configured exe or OS default), fs.watch → debounced re-upload + chmod;
                      Windows .txt-handler auto-detect (UserChoice registry) for settings prefill
  toolbar.ts          SftpPanelHotkeyProvider (declares toggle-sftp-panel) + SftpPanelBootstrap
                      (no visible button; bootstraps mount service + i18n + wires hotkey → focusPanel)
  i18n.service.ts     SftpI18nService (providedIn:root) — merges locale/<lang>.po into Tabby's live
                      ngx-translate catalog (setTranslation merge=true) on init + LocaleService
                      .localeChanged$. Only ships strings Tabby lacks; shared labels reuse Tabby's.
  locale/*.po         our gettext catalogs (de-DE, zh-CN, ru-RU, es-ES, fr-FR, ja-JP, pt-BR).
                      gap strings only, 96 msgid each, identical key sets. built via json-loader +
                      po-gettext-loader (webpack .po rule) — same chain Tabby uses. i18n.service
                      picks up new langs automatically (dynamic require → webpack context).
  settings.ts         settings tab for sftpPanel
  chmod-dialog.component.ts     ChmodDialogComponent — permissions (rwx grid) + owner/group modal
  copy-move-dialog.component.ts CopyMoveDialogComponent — destination input + Copy/Move buttons
  sftp-util.ts        pure helpers — file type/icon/mode, sort/filter, sizes/times, perms
                      (octalToPerms/permsToOctal), owners (parseLsOwners/parseNames), log
                      (LogEntry/logFullText/computeLogSelection), start-path (resolveStartPath),
                      columns (moveColumn), editor (parseFtypeExe/isBigFile), server-side cp/mv
                      (shQuote/buildCpCommand/expandDirs)
  logic.ts            dock math (clampSize/dockSize) — clampSize reused for transfer-list height
  *.test.ts           node:test units for sftp-util (24) + logic (4) = 28
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
npm test           # tsx --test src/*.test.ts — 28 units (sftp-util 24 + logic 4)
npx tsc --noEmit -p tsconfig.json   # REQUIRED type-check — build does NOT type-check
```

**Build gate blind spot:** webpack uses `ts-loader { transpileOnly: true }` → no type
check, no AOT template compile (Ivy runs JIT at runtime). A green `npm run build`
catches **neither** type errors **nor** template/module-scope errors (missing pipe/
directive throw only at first render). So: run `tsc --noEmit` for types, and a **live
Tabby smoke test is mandatory** for template-scope bugs.

Windows: `npm install` needs `.npmrc` `ignore-scripts=true` (tabby-ssh postinstall has
no win32 script; deps are webpack-externalized so install scripts are unneeded anyway).

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

```
npm login && npm publish       # prepublishOnly rebuilds dist/
npm version patch|minor|major  # then `git push --follow-tags` + publish again
```

`files: ["dist"]` beats `.gitignore` (dist is git-ignored but ships) — verify with
`npm pack --dry-run`. The manager shows the highest semver of a name; installs run
`npm install <pkg>@<version>` into `userPluginsPath`.

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
  in scope via TabbyCoreModule (re-exports TranslateModule) — but that's template-scope, so a
  live smoke test is the only real check. (4) **Merge-after-render refresh:** panels mount before
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

## Status

Live-smoke-verified in Electron Tabby. Merged to main:

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
