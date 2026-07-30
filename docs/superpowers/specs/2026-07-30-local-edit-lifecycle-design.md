# Local-edit lifecycle tracking (issue #5, part 2)

Status: approved 2026-07-30. Prerequisite (`openEdits` map, mtime baseline, save-time
conflict prompt) shipped in 43e2be1.

## Problem

`LocalEditService.edit()` unconditionally creates a fresh temp dir per invocation. Opening
the same remote file twice produces two temp copies, two `fs.watch` watchers and two
independent mtime baselines. The two watchers then overwrite each other on the server, and
each reports a conflict against the other's upload. There is also no way to recognise a
file as already checked out.

## Goal

One temp copy per (server, remote path), reused across re-opens and across tabs. A re-open
of an already checked-out file downloads nothing; it re-runs the opener on the existing
temp file and offers a reload when the server copy moved on.

## Scope

In scope: identity, cross-tab session registry, re-open handling with reload prompt,
save via any live session, lifecycle end tied to the last session.

Out of scope, deliberately deferred: polling for remote changes (the other half of #5 —
detection still happens on save and on re-open only), the "keep both" conflict option, a
panel marker for checked-out files.

## Design

### 1. Identity — `sftp-util.ts`

Two pure helpers, unit-tested:

```ts
hostKey(profile) => `${user}@${host}:${port}`
editKey(hostKey, remotePath) => hostKey + '\0' + remotePath
```

`SSHSession.profile` is public in tabby-ssh (`session/ssh.ts`, `constructor(injector,
public profile: SSHProfile)`) but absent from the panel's local structural type, so
`SSHSessionLike` in `panel.component.ts` gains
`profile?: { options: { host: string, port: number, user: string } }`.

`hostKey` returns `''` when the profile is missing. The service then falls back to a
per-`sftp` identity (a `WeakMap`-assigned counter), which degrades the feature to
per-session dedup instead of collapsing unrelated servers onto one key.

### 2. Session registry — `LocalEditService`

`private sessions = new Map<string, Set<any>>()` (hostKey → live `SFTPSession` handles).

- `registerSession(hostKey, sftp)` — called by the panel right after `openSFTP()`.
- `unregisterSession(hostKey, sftp)` — called on `sftp.closed$` and on panel destroy.
- `private liveSftp(hostKey): any | null` — any member of the set, or null.

A save therefore no longer depends on the tab that opened the file still existing.

### 3. Re-open

`openEdits` is re-keyed from temp dir to `editKey`. `OpenEdit` grows
`{ hostKey, tempDir, tempPath, mode, watcher }` alongside the existing
`{ remotePath, name, mtime }`.

`edit()` looks the key up first:

- **Unknown key** — current flow unchanged: `mkdtempSync`, fresh metadata read, download,
  `chmodSync(0o700)`, watcher, registration.
- **Known key** — no download. If the remote mtime is newer than the baseline, show a
  message box: *"{name} changed on the server since you opened it"* with buttons
  **Reload from server** / **Keep the local copy**, defaulting to keeping the local copy.
  Reload closes the watcher, downloads into the *same* temp path, refreshes the baseline
  and starts a new watcher. The watcher is recreated rather than reused because a download
  that replaces the file instead of truncating it leaves the old watcher attached to an
  unlinked inode. Either way, `opener(tempPath)` runs afterwards; for an editor that is
  still open this only raises its window.

### 4. Save

The watch handler resolves its `sftp` through `liveSftp(edit.hostKey)` instead of the
closure it was created with. No live handle means the existing failure modal fires, naming
the temp path so the changes can be recovered. The save-time conflict check
(`confirmNoConflict`) is unchanged apart from taking the resolved handle.

### 5. Lifecycle end

Superseded by a later design decision: a handle going away — tab closed, connection lost,
even the last session to a host unregistering — no longer tears anything down. `unregisterSession`
only drops the handle from the session registry (`hostKeys` + `sessions`); the `OpenEdit`
record, its temp file and its `fs.watch` watcher all keep living. The only thing that wipes
temp copies is Tabby's `beforeunload`, unchanged from before.

The tradeoff this buys: a save with no live handle for the file's server is no longer a dead
end. It offers to reconnect — a message box, and on confirmation `ProfilesService
.openNewTabForProfile(profile)` opens a real tab to that server (reusing Tabby's whole auth
flow: passwords, key prompts, known-hosts), remembered per host from the `profile` argument
`registerSession` already receives. The save then polls the session registry (every 500ms,
up to 60s, to cover an interactive password/2FA prompt) for that new tab's panel to register
its SFTP handle, and uploads once it does. Declining the prompt, or the handle never showing
up, fails the save the same way a missing connection always did.

## Error handling

- Missing profile → per-sftp fallback identity, feature degrades, no crash.
- Reload download fails → the transfer went to a `<tempPath>.part` sibling, not the live temp
  file, so a failed download deletes only the `.part` file; the existing temp file and its
  baseline are untouched. Log an error, still run the opener. The rename to `tempPath` (and
  the mtime/mode baseline update) only happens after the download succeeds.
- No live session at save time → offer to reconnect (see section 5). Declining, or the new
  tab's handle never registering within the poll window, falls through to the existing
  failure modal naming the temp path.
- `freshMeta` returning null (unreadable parent dir, symlink) keeps its current meaning:
  baseline 0 disables the conflict check.

## Testing

- node:test units in `sftp-util.test.ts` for `hostKey` (normal + missing profile) and
  `editKey`.
- The rest (watcher wiring, registry, dialogs) needs a live Tabby and is verified by hand:
  open a file twice in one tab, open it from two tabs, close the opening tab and save,
  change the file server-side and re-open it.
- `npx tsc --noEmit`, `npm test`, `npm run build` all green.

## i18n

New msgids (~4): the two reload buttons, the reload detail line, and the no-connection
message. Added to all seven `locale/*.po` files; `i18n.test.ts` enforces identical key
sets and non-empty msgstrs. No apostrophes in msgids (MessageFormat escape).
