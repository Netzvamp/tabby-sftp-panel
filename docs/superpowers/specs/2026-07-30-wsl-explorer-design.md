# WSL-tab explorer

Status: approved 2026-07-30. Branch `wsl-explorer`. Builds on the local-tab explorer
(`2026-07-30-local-tab-explorer-design.md`, shipped in v0.2.0).

## Problem

A WSL tab in Tabby is a local terminal tab: `profile.type === 'local'`, running
`wsl.exe -d <distro>`. So since v0.2.0 the panel mounts on it — and shows the **Windows**
filesystem, `C:\Users\…`, while the shell right next to it sits in `/home/<user>`. The one
place a file browser should agree with the terminal is the one place it silently does not.

## Goal

On a WSL tab, the panel browses that distribution's filesystem, presented as ordinary posix
paths (`/home/rlieback`), with the same capabilities the local explorer already has.

## Verified facts

Probed on the target machine (Windows 11, WSL2, distros Debian / Ubuntu (default) /
kali-linux). These are measurements, not assumptions, and several of them drive the design:

| Probe | Result |
|---|---|
| `fs` over `\\wsl$\Ubuntu\…` | readdir / stat / write / rename / `fs.cp` / `fs.rm` all work |
| `\\wsl$` (share root) | **not enumerable** — `Test-Path` false. Distro names cannot be discovered this way |
| `stat().mode` | always fake: `100666` for files, `40666` for dirs. `chmod` returns success and changes nothing |
| `lstat` / `stat` / `readlink` on a symlink (`/bin`) | **throw** `EISDIR` / `ENOENT` |
| `readdir(…, {withFileTypes:true})` | symlinks correctly flagged (`bin:L`, `lib:L`, `etc:d`) |
| `stat().dev` | always `0`. `ino` is real and distinct within a distro |
| `path.win32.resolve('\\\\wsl$\\Ubuntu', '..')` | `\\wsl$\Ubuntu\` — cannot escape above the share |
| `path.win32.basename('\\\\wsl$\\Ubuntu')` | `'Ubuntu'` (not `''`, unlike a drive root) |
| registry `HKCU\…\Lxss` | `DefaultDistribution` GUID → subkey with `DistributionName`, `DefaultUid` |

The fake `mode` and the throwing `lstat` are the two that change code.

## Design

### 1. Detection — `src/wsl.ts` (new)

A WSL tab is a local tab whose `profile.options.command` basename is `wsl.exe`, or the
legacy `bash.exe` under `%WINDIR%\system32`. The distro comes from `profile.options.args`
(`-d <name>` or `--distribution <name>`); with no such argument it is the default distro.

`fsBase` is *not* usable here: `Shell.fsBase` exists in tabby-local's API
(`_tabby-ref/tabby-local/src/api.ts:16`) but `optionsFromShell()`
(`_tabby-ref/tabby-local/src/profiles.ts:79`) never copies it into the profile, and the
default-distro shell does not set it at all (`_tabby-ref/tabby-electron/src/shells/wsl.ts:62`).

Distro metadata comes from one `reg.exe query HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss /s`,
parsed and cached module-wide: default distro name, plus `DefaultUid` per distro. `reg.exe`
rather than `windows-native-registry` — no new dependency, no native module, and no
assumption about how Tabby packages its own.

**Base path** is `\\wsl$\<distro>` for every distro, WSL1 included. Tabby's own code uses
the WSL1 `BasePath\rootfs` instead, but `\\wsl$` has served WSL1 since Windows 10 1903, so
one form covers both.

If the registry read fails and the profile carried no `-d`, the tab is not treated as WSL and
keeps today's behaviour (Windows filesystem). No error, no dialog.

The pure parts — argument parsing, `reg.exe` output parsing, `/etc/passwd` parsing — live in
functions with no `window` and no `fs`, so `node:test` can import them directly. Same split
as `local-path.ts`.

### 2. Base instead of the drive list

`LocalFsSession` gains `constructor (private base = '')`. Base set = a WSL session. Every
`toNativeFsPath(p)` call becomes `toNativeFsPath(p, this.base)`, which prepends the base and
converts separators. Virtual paths are therefore **real posix paths inside the distribution**
— `/home/rlieback`, not `/wsl$/Ubuntu/home/rlieback`. The panel then looks like an SSH tab,
which is what a WSL user expects and what makes the destination field, the log lines and Copy
path all correct with no display mapping of their own.

With a base set:

- `/` is a real directory, so `readdir('/')` lists the distro root instead of the drive list.
  `isVirtualRoot` / `driveRoots` / `isDriveRoot` are inert.
- `atVirtualRoot()` in the panel is false — create file/dir and drops work at `/`.
- `displayPath()` is the identity.
- `path.win32.resolve` cannot walk above the share, so the base cannot be escaped upward;
  `toNativeFsPath` still rejects anything that does not start with `/`.

`local-ops.ts` takes the base as a parameter on its five exported functions
(`localCopy`, `localMove`, `localTrash`, `localExists`, `localRefusal`); the panel passes the
value it got from the mount service. `mount.service.ts`'s `localWrapper()` computes the base
once per pane, hands it to `new LocalFsSession(base)`, and exposes it on the wrapper so the
panel can read it back.

### 3. Start directory and `~`

`startDirectory` applies when it is set, starts with `/`, and exists in the distribution.
Otherwise `~`, resolved as: `DefaultUid` → the matching line in
`\\wsl$\<distro>\etc\passwd` → its home field. No match → `/root` (uid 0) → `/`.

The terminal's working directory is ignored on WSL tabs. `wsl.exe` is a Windows process whose
CWD is a Windows path (`C:\…`), so `getWorkingDirectory()` reports something that is not a
path in the distribution at all.

### 4. Delete is permanent

`shell.trashItem` on `\\wsl$` has no recycle bin to reach — it fails, or worse, deletes
permanently anyway (the `IFileOperation` network-share caveat already recorded in AGENTS.md).
So a WSL session deletes with `fs.rm` directly, and the confirmation says so: permanent, no
recycle bin. Holding **Shift** skips the confirmation, matching Explorer's Shift+Delete;
`deleteSelected(skipConfirm)` already implements the bypass (`panel.component.ts:1784`), only
the wording and the removal call change.

The same applies to the overwrite path in `local-ops.ts`. `clearDestination` removes with
`fs.rm` on a WSL base, and both the overwrite prompt and the "already moved to the recycle
bin" message change wording to say the destination was removed permanently. The prompt says
it *before* the removal, so consenting to Overwrite is still informed consent. Shift bypasses
the delete confirmation only — the overwrite prompt always asks, exactly as Explorer does.

### 5. Symlinks

`LocalFsSession.entry()` currently catches every `lstat` failure and returns `null`, which
drops the entry from the listing. On WSL that silently hides `/bin`, `/lib`, `/sbin` and every
other symlink. It instead falls back to the `Dirent` flags from
`readdir(…, {withFileTypes:true})`, yielding a row that is correctly typed as a symlink but
carries no size or mtime. A row without metadata beats a missing row.

This touches only the failure path; on NTFS `lstat` succeeds and nothing changes.

### 6. Config

`sftpPanel.wslTabs: true` — a WSL tab shows its distribution's filesystem. Turned off, WSL
tabs fall back to the Windows filesystem, i.e. exactly v0.2.0 behaviour. The settings
checkbox renders **only on win32**, where the option can mean anything.

### 7. Deliberately unchanged

- Permissions column and chmod stay hidden on win32. 9p reports `100666` for everything and
  `chmod` is a no-op, so an rwx grid there would be a lie. Nothing to gate, nothing to add.
- Copy path yields the posix path (`/home/rlieback/x.txt`) — the path that pastes into the
  shell next to it. The editor still receives the UNC path, since a Windows editor needs one.
- Upload/download affordances stay hidden, as on any local tab.

### 8. Testing

`node:test` units for the pure helpers: command/args → distro, `reg.exe` output → distro map,
`/etc/passwd` + uid → home, and `toNativeFsPath` with a base (including the refusal of a path
that does not start with `/`). Plus a `LocalFsSession` roundtrip against a temp directory with
a synthetic base, and the `entry()` dirent fallback driven by a stubbed `lstat`.

`npx tsc --noEmit -p tsconfig.json` and `npm test` both required, per AGENTS.md.

### 9. Known limits

- **`dev` is 0 over 9p.** dev+ino identity holds within one filesystem, but `/mnt/c/…` and
  `/home/…` are different filesystems behind the same `dev = 0`; colliding inodes there cause
  a **false refusal** of a copy or move. Loud, no data loss — the same direction as the
  documented `ino === 0` limit, and fixed the same way: not at all.
- **No recycle bin.** Delete and Overwrite are permanent on a WSL tab. This is stated in the
  prompt rather than worked around.
- **Accessing `\\wsl$\<distro>` starts the distribution** if it is not running. Harmless here
  — the tab is running that distribution anyway.
- **9p is slower than NTFS.** Large directory listings are noticeably less snappy. Accepted.
- **The template half of the build gate is still open** (AGENTS.md): the new settings
  checkbox and any changed template branch surface only when the panel renders in a running
  Tabby.
