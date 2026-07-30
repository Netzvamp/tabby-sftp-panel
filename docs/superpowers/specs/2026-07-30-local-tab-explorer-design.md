# Local-tab explorer

Status: approved 2026-07-30. Evaluated on branch `local-tab-explorer`.

## Problem

The panel mounts only on tabs that hold an SSH pane (`mount.service.ts:64`,
`isSSHTab` = `openSFTP` is a function and `sshSession` is present). A local terminal tab
gets no panel at all, so there is no file browser next to a local shell — the one place
where a file browser is otherwise a whole separate application.

## Goal

The same panel, on local terminal tabs, backed by the local filesystem instead of SFTP.
Full explorer capability: browse, navigate, rename, delete, create file/directory,
copy/move, drag in and out of the OS file manager, open in an editor.

## Scope

In scope: a filesystem-backed session adapter, mount wiring for local panes (including
mixed splits), the four behaviour branches the local case genuinely needs, one config
flag, pure-helper and adapter tests.

Out of scope, deliberately deferred:

- Live CWD following. The panel takes the terminal's working directory once, at mount.
  Tabby emits no CWD event, so following would need polling plus a follow/unfollow toggle
  to stop it fighting manual navigation.
- Owner/group columns on local tabs. Only the current user's name is resolvable
  (`os.userInfo`); a column that shows one name and blanks for everything else is worse
  than no column.
- A second panel instance per split. One panel per top-level tab stays the rule; the
  focused pane decides what it shows.

## Design

### 1. The adapter — `src/local-fs.session.ts`

`LocalFsSession` duck-types `SFTPSession`. The panel calls ~40 sites against
`this.sftp`, and the API surface they use is small: `readdir`, `stat`, `readlink`, `open`,
`mkdir`, `rmdir`, `unlink`, `rename`, `chmod`, `upload`, `download` (verified against
`_tabby-ref/tabby-ssh/src/session/sftp.ts`). Implementing that surface over `fs` leaves
every call site unchanged.

**Path flavour.** `panel.component.ts:1` imports `posix as path` and uses posix semantics
throughout. Native Windows paths break that: `posix.resolve('C:/a/b', '..')` does not
recognise `C:/` as a root, so it prepends `process.cwd()` and returns garbage. The adapter
therefore presents a *virtual posix path* and converts only at the `fs` boundary:

```
win32:  /C:/Users/x   <->  C:\Users\x
posix:  /home/x       <->  /home/x        (identity)
```

Pure helpers, unit-tested: `toNativePath(virtual)`, `toVirtualPath(native)`,
`isVirtualRoot(p)`, `driveRoots()`.

**Root listing.** On win32, `readdir('/')` returns the drives. Probe `A:\` … `Z:\` with
`fs.existsSync` — 26 syscalls, instant, no dependency, and no dependence on the deprecated
`wmic`. On posix, `/` is a normal directory.

**Method mapping.**

| `SFTPSession` | `LocalFsSession` |
|---|---|
| `readdir` | `fs.readdir(withFileTypes)` + `lstat` per entry, `Promise.all`. `Stats.mode` already carries the file-type bits (`0o100644`), matching what the panel expects everywhere. |
| `stat` | `fs.stat` for size/mode/mtime, `fs.lstat` for `isSymlink` |
| `readlink` / `mkdir` / `rmdir` / `unlink` / `rename` / `chmod` / `open` | direct `fs.promises` equivalents |
| `upload` / `download` | stream through the same `FileUpload` / `FileDownload` interface, backed by an fs handle |

Implementing `upload`/`download` rather than stubbing them is what keeps drag-in,
drag-out, the transfer log rows, the progress bars and the per-row Stop button working with
no panel changes at all.

The panel never subscribes to `sftp.closed$`, so the adapter does not need it.

### 2. Mount wiring — `mount.service.ts`

- Add `isLocalTab(tab) = tab.profile?.type === 'local'` (the type string set by
  `tabby-local`'s profile provider, `_tabby-ref/tabby-local/src/profiles.ts:42`), gated on
  `config.store.sftpPanel.localTabs`.
- Rename `sshPanes` → `fsPanes` and `focusedSSHPane` → `focusedFsPane`; both now accept SSH
  and local panes.
- For a local pane, hand the panel a wrapper `{ openSFTP: () => new LocalFsSession() }`.
  `setSession()` (`panel.component.ts:478`) then needs no change. The adapter is stateless —
  it holds no working directory; the panel navigates absolute virtual paths, and the start
  directory is resolved separately (below).

**Mixed splits: the focused pane wins.** Focus a local pane and the panel shows the local
filesystem; focus the SSH pane and it shows SFTP. This runs entirely through the existing
`focusChanged$ → updateSession()` subscription (`mount.service.ts:215-221`), so it costs
nothing extra.

**Two small branches in `openSFTPIfNeeded`** (`panel.component.ts:497`):

- Skip the `shellSession?.shell` poll for local sessions. That loop waits up to 5s
  (`panel.component.ts:508`); a local session has no `shell` field to satisfy it, and would
  eat the full timeout before the panel worked.
- Skip `localEdit.registerSession()` (`panel.component.ts:520`) — that registry is keyed by
  `user@host:port` and exists to route re-uploads to a live SSH session.

**Start directory.** At mount, `session.getWorkingDirectory()`
(`_tabby-ref/tabby-local/src/session.ts:199`). The existing `startDirectory` config value
wins when set.

### 3. Behaviour branches — `src/local-ops.ts`

The panel gets one flag, `isLocal`, set by the mount service alongside the session. Four
behaviours differ; their implementations live in `local-ops.ts` rather than as inline
branches scattered through a 1840-line component.

| Feature | Local behaviour |
|---|---|
| Edit locally | Becomes **open in editor**: `opener(toNativePath(item.fullPath))`. The existing `Opener` type is `(path: string) => void \| Promise<void>` (`local-edit.service.ts:10`) and takes a plain path, so `spawnOpener()` and `defaultOpener` are reused verbatim. No temp copy, no `fs.watch`, no re-upload, no conflict handling — the file the editor writes *is* the file. |
| Copy / Move | `fs.cp(recursive)` and `fs.rename`, with an EXDEV fallback to copy-then-remove for cross-volume moves. Replaces the `buildCpCommand` + `exec` path, which shells out `cp -r` and would not survive a PowerShell or cmd host. The dialog itself is unchanged. |
| Delete | `shell.trashItem()` via `(window as any).require('electron').shell`, not `fs.rm`. Deleting a local file has no remote-backup safety net, and the OS already owns undo. |
| chmod / owner | Owner and group columns hidden on local tabs (see Scope). chmod stays available on posix; hidden on win32, where `fs.chmod` only toggles the read-only bit and any rwx grid we show would be a lie. |

The Upload and Download toolbar buttons are hidden on local tabs — source and destination
are the same filesystem. Drag-in and drag-out stay.

Everything that goes through `exec()` (`panel.component.ts:544`) degrades on its own:
`exec()` returns `null` when `(this.session as any).ssh` is absent, which is already the
"no data" path for home resolution, `ls -l` owner parsing, root detection and chown.

### 4. Config

`sftpPanel.localTabs: true` — on by default, so local tabs behave like SSH tabs — plus a
settings checkbox. This is the only new config key.

### 5. Testing

- Pure path helpers (`toNativePath`, `toVirtualPath`, `isVirtualRoot`, `driveRoots`), both
  flavours, in `local-fs.session.test.ts` under `node:test` like the existing 36 units.
- One adapter roundtrip against a temp directory: `mkdir` → `readdir` → `stat` → `rename`
  → `chmod` (posix only) → `unlink`. Real `fs`, no mocks, no fixtures.
- `npx tsc --noEmit -p tsconfig.json` and `npm test` both required, per AGENTS.md.

### 6. Known risk

The build gate does not type-check templates and Angular runs JIT, so neither
`npm run build` nor `npm test` verifies the new template branches — a missing directive or
pipe surfaces as `NG0302` at first render only. Every UI branch added here (hidden columns,
hidden buttons, the relabelled edit action) has to be checked in a running Tabby before the
branch is considered evaluated.
