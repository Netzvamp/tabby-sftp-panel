# Local-edit lifecycle tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One temp copy per (server, remote path) for "edit locally", reused across re-opens and across tabs, with the save path surviving the tab that opened the file.

**Architecture:** Two pure helpers (`hostKey`, `editKey`) plus a plain `SessionRegistry` class move into `sftp-util.ts` where node:test can reach them. `LocalEditService` re-keys its `openEdits` map from temp dir to `editKey`, keeps a registry of live `SFTPSession` handles per server, resolves the handle for a save at save time instead of capturing it in a closure, and short-circuits `edit()` to a re-open path when the file is already checked out.

**Tech Stack:** TypeScript, Angular 15 (JIT, via Tabby's DI), rxjs, node:test via tsx, webpack (ts-loader `transpileOnly`), gettext `.po` catalogs.

**Spec:** `docs/superpowers/specs/2026-07-30-local-edit-lifecycle-design.md`

## Global Constraints

- Run `npm run build` after every code change — Tabby loads `dist/index.js`, not the sources.
- `npx tsc --noEmit -p tsconfig.json` is REQUIRED; the build does not type-check (`transpileOnly: true`).
- `npm test` runs `tsx --test src/*.test.ts`; it currently passes 33 units and must stay green.
- Node built-ins come from Electron's loader: `const req = (window as any).require` — never a bare `import` of `fs`/`os`/`path` in runtime code (a junctioned plugin would resolve its own copy).
- Runtime classes from Tabby are reached via `(window as any).require('tabby-ssh')`, never a bare import.
- New user-visible strings go through `this.translate.instant(...)` and must be added to **all seven** catalogs in `locale/` (de-DE, zh-CN, ru-RU, es-ES, fr-FR, ja-JP, pt-BR). `i18n.test.ts` fails if the msgid sets drift or any msgstr is empty.
- No apostrophe (`'`) inside a **msgid** — it is a MessageFormat escape char and mangles the English fallback. Apostrophes inside translations are fine (the catalogs already contain them).
- Do not add npm dependencies. Do not run `npm audit fix`.
- Do not run `npm publish` or `npm version` — releases are a separate, CI-owned step.
- `SFTPSession.stat()` is unusable for metadata (mode 0, mtime epoch). Metadata always comes from `freshMeta()`, which reads the parent dir with `readdir` and picks the entry out.

---

### Task 1: Identity helpers and session registry (pure)

**Files:**
- Modify: `src/sftp-util.ts` (append at end of file)
- Test: `src/sftp-util.test.ts` (append at end of file)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `hostKey(profile: any): string` — `"user@host:port"`, or `''` when no profile/host.
  - `editKey(host: string, remotePath: string): string` — `host + '\0' + remotePath`.
  - `class SessionRegistry` with `add(key: string, session: any): void`, `remove(key: string, session: any): boolean` (true = that server has no sessions left), `any(key: string): any | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/sftp-util.test.ts`:

```ts
test('hostKey builds user@host:port and degrades to empty without a profile', () => {
  assert.equal(hostKey({ options: { user: 'root', host: 'example.com', port: 2222 } }), 'root@example.com:2222')
  assert.equal(hostKey({ options: { host: 'example.com' } }), '@example.com:22')
  assert.equal(hostKey(undefined), '')
  assert.equal(hostKey({ options: {} }), '')
})

test('editKey separates host from path with NUL so keys cannot collide', () => {
  assert.equal(editKey('root@h:22', '/etc/hosts'), 'root@h:22\0/etc/hosts')
  assert.notEqual(editKey('a', 'b/c'), editKey('a/b', 'c'))
})

test('SessionRegistry hands out any live session and reports the last one leaving', () => {
  const r = new SessionRegistry()
  const a = { id: 'a' }, b = { id: 'b' }
  assert.equal(r.any('h'), null)
  r.add('h', a)
  r.add('h', b)
  assert.ok([a, b].includes(r.any('h')))
  assert.equal(r.remove('h', a), false)   // b still holds the host
  assert.equal(r.any('h'), b)
  assert.equal(r.remove('h', b), true)    // last one out
  assert.equal(r.any('h'), null)
  assert.equal(r.remove('h', b), false)   // removing twice is not a "last one out" again
})
```

Add the imports at the top of the same file (keep the existing import style — one grouped line per concern):

```ts
import { hostKey, editKey, SessionRegistry } from './sftp-util'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `SyntaxError`/`TypeError` about `hostKey`, `editKey` or `SessionRegistry` not being exported by `./sftp-util`.

- [ ] **Step 3: Implement the helpers**

Append to `src/sftp-util.ts`:

```ts
/** Server identity for local-edit dedup: same user+host+port means the same file.
 *  Returns '' when the profile is unavailable — the caller then falls back to a
 *  per-handle id, so dedup degrades to per-session instead of merging servers. */
export function hostKey (profile: any): string {
    const o = profile?.options
    if (!o?.host) { return '' }
    return `${o.user ?? ''}@${o.host}:${o.port ?? 22}`
}

/** Map key for one checked-out file. NUL separates the two halves, so no host/path
 *  split can produce the same string as a different one. */
export function editKey (host: string, remotePath: string): string {
    return host + '\0' + remotePath
}

/** Live SFTP handles per server key. A save resolves its handle through this instead of
 *  capturing one, so it still works after the tab that opened the file is gone. */
export class SessionRegistry {
    private byHost = new Map<string, Set<any>>()

    add (key: string, session: any): void {
        const set = this.byHost.get(key) ?? new Set<any>()
        set.add(session)
        this.byHost.set(key, set)
    }

    /** Drops one session; true when that server has no sessions left at all. */
    remove (key: string, session: any): boolean {
        const set = this.byHost.get(key)
        if (!set?.delete(session)) { return false }
        if (set.size) { return false }
        this.byHost.delete(key)
        return true
    }

    any (key: string): any | null {
        return this.byHost.get(key)?.values().next().value ?? null
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 36 tests (33 existing + 3 new).

- [ ] **Step 5: Type-check and build**

Run: `npx tsc --noEmit -p tsconfig.json && npm run build`
Expected: both silent/successful.

- [ ] **Step 6: Commit**

```bash
git add src/sftp-util.ts src/sftp-util.test.ts
git commit -m "feat: add host/edit key helpers and a session registry"
```

---

### Task 2: Re-key openEdits and resolve the save handle from the registry

This task changes how an edit is stored and how a save finds its connection. Re-open handling comes in Task 3 — after this task, opening the same file twice still produces two temp copies (the second `edit()` call overwrites the map entry). That is expected; do not fix it here.

**Files:**
- Modify: `src/local-edit.service.ts`
- Modify: `src/panel.component.ts` (interface `SSHSessionLike` ~line 28, `setSession` ~line 475, `openIfReady` ~line 514, `ngOnDestroy` ~line 571)

**Interfaces:**
- Consumes: `hostKey`, `editKey`, `SessionRegistry` from Task 1.
- Produces:
  - `LocalEditService.registerSession(sftp: any, profile: any): void`
  - `LocalEditService.unregisterSession(sftp: any): void`
  - internal `OpenEdit` shape used by Task 3:
    ```ts
    interface OpenEdit {
      key: string          // editKey(hostKey, remotePath)
      hostKey: string
      remotePath: string
      name: string
      tempDir: string
      tempPath: string
      mode: number         // remote mode, re-applied after every upload
      mtime: number        // remote mtime (ms) as of our last transfer; 0 = unknown
      watcher: any | null  // fs.FSWatcher while we are watching the temp file
    }
    ```
  - internal `private startWatching(edit: OpenEdit): void`
  - internal `private save(edit: OpenEdit): Promise<void>`
  - internal `private rmTemp(edit: OpenEdit): void`

- [ ] **Step 1: Add the imports and fields**

In `src/local-edit.service.ts`, extend the existing `sftp-util` import and add the new fields.

```ts
import { parseFtypeExe, describeSftpError, hostKey, editKey, SessionRegistry } from './sftp-util'
```

Replace the `OpenEdit` interface and the `openEdits` field (currently lines 12-26) with:

```ts
// One file checked out for local editing. Keyed by editKey(hostKey, remotePath), so the
// same file on the same server is ONE temp copy no matter how often or from how many tabs
// it gets opened.
interface OpenEdit {
  key: string
  hostKey: string
  remotePath: string
  name: string
  tempDir: string
  tempPath: string
  mode: number    // remote mode, re-applied after every upload
  mtime: number   // remote mtime (ms) as of the last transfer WE made — the baseline a
                  // conflict is measured against. 0 = unknown, which disables the check.
  watcher: any | null
}

@Injectable({ providedIn: 'root' })
export class LocalEditService {
  // Files currently checked out for editing. The temp dirs are wiped when Tabby's window
  // unloads, so quitting leaves no downloaded copies behind — and an editor still holding
  // one gets the "file no longer exists" prompt instead of silently saving into the void.
  private openEdits = new Map<string, OpenEdit>()
  // Live SFTP handles per server. A save picks one from here, so closing the tab that
  // opened a file does not orphan it while another tab to the same server is still up.
  private sessions = new SessionRegistry()
  private hostKeys = new WeakMap<any, string>()
  private fallbackSeq = 0
```

- [ ] **Step 2: Rewrite the unload hook and `rmTemp`**

The `beforeunload` listener in the constructor iterated map keys (temp dirs). It now iterates the edits:

```ts
    window.addEventListener('beforeunload', () => {
      for (const edit of [...this.openEdits.values()]) { this.rmTemp(edit) }
    })
  }

  private rmTemp (edit: OpenEdit): void {
    edit.watcher?.close()
    edit.watcher = null
    this.openEdits.delete(edit.key)
    try { fs.rmSync(edit.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
```

- [ ] **Step 3: Add the registry API**

Add these methods to `LocalEditService` (put them right after `rmTemp`):

```ts
  // Called by the panel once its SFTP handle is up. `profile` is the SSHSession's profile
  // (public in tabby-ssh, absent from our structural typing) — without it we fall back to a
  // per-handle id, which degrades dedup to per-session rather than merging unrelated servers.
  registerSession (sftp: any, profile: any): void {
    if (this.hostKeys.has(sftp)) { return }
    const key = hostKey(profile) || `session-${++this.fallbackSeq}`
    this.hostKeys.set(sftp, key)
    this.sessions.add(key, sftp)
    sftp.closed$?.subscribe(() => this.unregisterSession(sftp))
  }

  // Last handle for a server gone → nothing can upload there any more, so stop watching and
  // drop that server's temp copies. Other tabs to the same server keep the edits alive.
  unregisterSession (sftp: any): void {
    const key = this.hostKeys.get(sftp)
    if (!key) { return }
    this.hostKeys.delete(sftp)
    if (!this.sessions.remove(key, sftp)) { return }
    for (const edit of [...this.openEdits.values()]) {
      if (edit.hostKey === key) { this.rmTemp(edit) }
    }
  }

  private keyFor (sftp: any): string {
    if (!this.hostKeys.has(sftp)) { this.registerSession(sftp, null) }
    return this.hostKeys.get(sftp)!
  }
```

- [ ] **Step 4: Rewrite `edit()` around the new record**

Replace the body of `edit()` (currently lines 124-171) with:

```ts
  async edit (sftp: any, item: any, mode: number, size: number, opener: Opener): Promise<void> {
    const host = this.keyFor(sftp)
    const key = editKey(host, item.fullPath)

    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sftp-panel-'))  // stdlib mkdtemp, no tmp-promise dep
    const tempPath = nodePath.join(tempDir, item.name)

    // The panel's listing can be minutes old. Re-read the metadata so the transfer's declared
    // size is the real one — FileTransfer.isComplete() is `completedBytes >= getSize()`, so a
    // stale size makes the download report complete early or never complete at all. The same
    // read supplies the mtime baseline the conflict check measures against.
    const start = await this.freshMeta(sftp, item.fullPath)
    if (start) { mode = start.mode; size = start.size }
    const edit: OpenEdit = {
      key, hostKey: host, remotePath: item.fullPath, name: item.name,
      tempDir, tempPath, mode, mtime: +(start?.modified ?? 0), watcher: null,
    }
    this.openEdits.set(key, edit)

    try {
      const transfer = await (this.platform as any).startDownload(item.name, mode, size, tempPath)
      if (!transfer) { this.rmTemp(edit); return }
      await sftp.download(item.fullPath, transfer)
      await opener(tempPath)
    } catch (e) {
      this.rmTemp(edit)
      throw e
    }

    fs.chmodSync(tempPath, 0o700)
    // Skip the download's own write burst before watching.
    setTimeout(() => this.startWatching(edit), 1000)
  }

  // Watch the temp file and re-upload on save. Split out of edit() because a reload
  // (Task 3) has to tear the watcher down and build a fresh one on the same path.
  private startWatching (edit: OpenEdit): void {
    if (!this.openEdits.has(edit.key)) { return }   // cleaned up while we waited
    const events = new Subject<string>()
    const watcher = fs.watch(edit.tempPath, (ev: string) => events.next(ev))
    edit.watcher = watcher
    events.pipe(debounceTime(1000), debounce(async (ev: string) => {
      if (ev === 'rename') { watcher.close() }
      await this.save(edit)
    })).subscribe()
    watcher.on('close', () => events.complete())
  }

  // Push the temp file back to the server. The handle is resolved HERE, not captured when
  // the watcher was created, so the save still works after the opening tab is closed.
  private async save (edit: OpenEdit): Promise<void> {
    try {
      const sftp = this.sessions.any(edit.hostKey)
      if (!sftp) { throw new Error(this.translate.instant('No open connection to {host}', { host: edit.hostKey })) }
      if (!await this.confirmNoConflict(sftp, edit)) { return }
      const upload = await (this.platform as any).startUpload({ multiple: false }, [edit.tempPath])
      if (!upload.length) { return }
      await sftp.upload(edit.remotePath, upload[0])
      await sftp.chmod(edit.remotePath, edit.mode)
      // Our own write moved the remote mtime — rebase the baseline on it, or the very
      // next save would report a conflict against ourselves.
      edit.mtime = +((await this.freshMeta(sftp, edit.remotePath))?.modified ?? 0)
    } catch (e: any) {
      this.reportUploadFailure(edit.name, edit.tempPath, e)
    }
  }
```

Note what disappeared: the old `sftp.closed$.subscribe(() => { watcher.close(); cleanup() })` line. That job now belongs to `unregisterSession`, which only fires once the *last* handle for the server is gone. The `cleanup` local and the `const events`/`watcher` block that lived inside `edit()` are gone with it.

- [ ] **Step 5: Wire the panel to the registry**

In `src/panel.component.ts`, extend the structural type (~line 28):

```ts
interface SSHSessionLike {
    openSFTP(): Promise<SFTPSession>
    willDestroy$?: { subscribe(fn: () => void): { unsubscribe(): void } }
    // Public on tabby-ssh's SSHSession (`constructor(injector, public profile: SSHProfile)`)
    // but not in its exported typings — declared here for the local-edit host identity.
    profile?: { options: { host: string, port: number, user: string } }
}
```

In `openIfReady()`, right after `this.sftp = await this.session.openSFTP()` (~line 514):

```ts
            this.localEdit.registerSession(this.sftp, this.session.profile)
```

In `setSession()` (~line 476-478), drop the dead handle from the registry when Tabby swaps the session on reconnect — otherwise a save could pick a closed handle:

```ts
        const swapped = this.session && session !== this.session
        if (swapped && this.sftp) { this.localEdit.unregisterSession(this.sftp) }
        this.session = session
        if (swapped) { this.sftp = null as any; this.opening = false }
```

In `ngOnDestroy()` (~line 571), before the existing lines:

```ts
        if (this.sftp) { this.localEdit.unregisterSession(this.sftp) }
```

- [ ] **Step 6: Type-check, test, build**

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run build`
Expected: type-check silent, 36 tests pass, build writes `dist/index.js`.

- [ ] **Step 7: Commit**

```bash
git add src/local-edit.service.ts src/panel.component.ts
git commit -m "refactor: key local edits by server and path, resolve save handle at save time"
```

---

### Task 3: Re-open an already checked-out file

**Files:**
- Modify: `src/local-edit.service.ts`

**Interfaces:**
- Consumes: `OpenEdit`, `startWatching`, `rmTemp`, `freshMeta`, `sessions` from Task 2.
- Produces: nothing further tasks depend on.

- [ ] **Step 1: Short-circuit `edit()` on a known key**

Insert immediately after the `const key = editKey(host, item.fullPath)` line added in Task 2, before the `mkdtempSync` call:

```ts
    const existing = this.openEdits.get(key)
    if (existing) { await this.reopen(existing, opener); return }
```

- [ ] **Step 2: Add `reopen` and `reload`**

Add both methods right after `save()`:

```ts
  // Already checked out: no download, no second temp copy — just point the editor at the
  // file we have. Offer a reload first when the server copy moved on since our last
  // transfer, which is the only moment (short of a save) we can notice that.
  private async reopen (edit: OpenEdit, opener: Opener): Promise<void> {
    const sftp = this.sessions.any(edit.hostKey)
    const remote = sftp ? await this.freshMeta(sftp, edit.remotePath) : null
    if (remote && edit.mtime && +remote.modified > edit.mtime) {
      const r = await this.platform.showMessageBox({
        type: 'warning',
        message: this.translate.instant('{name} changed on the server since you opened it', { name: edit.name }),
        detail: this.translate.instant('Reloading replaces the local copy and discards unsaved editor changes.'),
        buttons: [this.translate.instant('Reload from server'), this.translate.instant('Keep the local copy')],
        defaultId: 1, cancelId: 1,
      })
      if (r.response === 0) { await this.reload(sftp, edit, remote) }
    }
    // Runs in both branches: for an editor that is still open this only raises its window.
    await opener(edit.tempPath)
  }

  // Re-download into the SAME temp path, so an editor that already has the file open sees a
  // change instead of losing it. The watcher is closed first and rebuilt afterwards: our own
  // write would otherwise bounce straight back as an upload, and a download that replaces the
  // file rather than truncating it would leave the old watcher on an unlinked inode.
  private async reload (sftp: any, edit: OpenEdit, remote: any): Promise<void> {
    edit.watcher?.close()
    edit.watcher = null
    try {
      const transfer = await (this.platform as any).startDownload(edit.name, remote.mode, remote.size, edit.tempPath)
      if (transfer) {
        await sftp.download(edit.remotePath, transfer)
        edit.mode = remote.mode
        edit.mtime = +remote.modified
        fs.chmodSync(edit.tempPath, 0o700)
      }
    } catch (e: any) {
      // Keep the local copy and the old baseline; the user still gets their editor.
      this.log.log('error', this.translate.instant('Could not open {name}', { name: edit.name }), describeSftpError(e))
    } finally {
      setTimeout(() => this.startWatching(edit), 1000)   // skip our own write burst
    }
  }
```

- [ ] **Step 3: Type-check, test, build**

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run build`
Expected: type-check silent, 36 tests pass, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/local-edit.service.ts
git commit -m "feat: reuse the temp copy when reopening a file that is already checked out"
```

---

### Task 4: Translations for the new strings

**Files:**
- Modify: `locale/de-DE.po`, `locale/zh-CN.po`, `locale/ru-RU.po`, `locale/es-ES.po`, `locale/fr-FR.po`, `locale/ja-JP.po`, `locale/pt-BR.po`

**Interfaces:**
- Consumes: the four new msgids introduced in Tasks 2-3 (`Reload from server`, `Keep the local copy`, `Reloading replaces the local copy and discards unsaved editor changes.`, `No open connection to {host}`).
- Produces: nothing.

- [ ] **Step 1: Run the i18n test to see it fail**

Do this before editing the catalogs — it proves the guard actually guards.

Temporarily append to `locale/de-DE.po`:

```
msgid "Reload from server"
msgstr "Vom Server neu laden"
```

Run: `npm test`
Expected: FAIL. `de-DE.po` is the reference catalog, so the drift assertion reports the other six as
`missing: [ 'Reload from server' ]`.

- [ ] **Step 2: Append all four entries to every catalog**

`locale/de-DE.po` (replace the temporary entry from Step 1 with the full block):

```
msgid "Reload from server"
msgstr "Vom Server neu laden"

msgid "Keep the local copy"
msgstr "Lokale Kopie behalten"

msgid "Reloading replaces the local copy and discards unsaved editor changes."
msgstr "Neu laden ersetzt die lokale Kopie und verwirft ungespeicherte Änderungen im Editor."

msgid "No open connection to {host}"
msgstr "Keine offene Verbindung zu {host}"
```

`locale/zh-CN.po`:

```
msgid "Reload from server"
msgstr "从服务器重新加载"

msgid "Keep the local copy"
msgstr "保留本地副本"

msgid "Reloading replaces the local copy and discards unsaved editor changes."
msgstr "重新加载会替换本地副本，并丢弃编辑器中未保存的更改。"

msgid "No open connection to {host}"
msgstr "没有到 {host} 的可用连接"
```

`locale/ru-RU.po`:

```
msgid "Reload from server"
msgstr "Загрузить с сервера заново"

msgid "Keep the local copy"
msgstr "Оставить локальную копию"

msgid "Reloading replaces the local copy and discards unsaved editor changes."
msgstr "Повторная загрузка заменит локальную копию и отменит несохранённые изменения в редакторе."

msgid "No open connection to {host}"
msgstr "Нет открытого подключения к {host}"
```

`locale/es-ES.po`:

```
msgid "Reload from server"
msgstr "Recargar desde el servidor"

msgid "Keep the local copy"
msgstr "Mantener la copia local"

msgid "Reloading replaces the local copy and discards unsaved editor changes."
msgstr "Recargar reemplaza la copia local y descarta los cambios sin guardar del editor."

msgid "No open connection to {host}"
msgstr "No hay conexión abierta con {host}"
```

`locale/fr-FR.po`:

```
msgid "Reload from server"
msgstr "Recharger depuis le serveur"

msgid "Keep the local copy"
msgstr "Conserver la copie locale"

msgid "Reloading replaces the local copy and discards unsaved editor changes."
msgstr "Le rechargement remplace la copie locale et abandonne les modifications non enregistrées de l'éditeur."

msgid "No open connection to {host}"
msgstr "Aucune connexion ouverte vers {host}"
```

`locale/ja-JP.po`:

```
msgid "Reload from server"
msgstr "サーバーから再読み込み"

msgid "Keep the local copy"
msgstr "ローカルのコピーを保持"

msgid "Reloading replaces the local copy and discards unsaved editor changes."
msgstr "再読み込みするとローカルのコピーが置き換えられ、エディターの未保存の変更は破棄されます。"

msgid "No open connection to {host}"
msgstr "{host} への接続が開いていません"
```

`locale/pt-BR.po`:

```
msgid "Reload from server"
msgstr "Recarregar do servidor"

msgid "Keep the local copy"
msgstr "Manter a cópia local"

msgid "Reloading replaces the local copy and discards unsaved editor changes."
msgstr "Recarregar substitui a cópia local e descarta as alterações não salvas do editor."

msgid "No open connection to {host}"
msgstr "Sem conexão aberta com {host}"
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 36 tests. Each catalog now has 113 non-header msgids.

- [ ] **Step 4: Build and commit**

```bash
npm run build
git add locale
git commit -m "i18n: strings for the local-edit reload prompt"
```

---

### Task 5: Manual verification in a running Tabby and docs

Neither the build nor `tsc` catches Angular template/module-scope errors, and none of the watcher, registry or dialog wiring has automated coverage. This task is the check.

**Files:**
- Modify: `AGENTS.md` (the `local-edit.service.ts` line in the Layout section, and the last bullet of the Status section)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing.

- [ ] **Step 1: Deploy the build into Tabby**

Confirm the junction exists, then fully restart Tabby (plugins are scanned only at startup):

```powershell
Get-Item "$env:APPDATA\tabby\plugins\node_modules\tabby-sftp-panel"
```

If it is missing:

```powershell
New-Item -ItemType Junction -Path "$env:APPDATA\tabby\plugins\node_modules\tabby-sftp-panel" -Target "C:\Nextcloud\Projekte\tabby-sftp-panel"
```

- [ ] **Step 2: Walk the five scenarios**

Against a real SSH host, with `fileClickAction: edit` and an editor configured:

1. **Re-open, same tab.** Open a text file, type something, save. Open the same file again from the panel → the editor comes forward with your text still there, no second download appears in the transfer log. Check `%TEMP%` — exactly one `sftp-panel-*` dir for that file.
2. **Re-open, second tab.** Open a second tab to the same host, open the same file there → same temp copy, no download.
3. **Remote changed.** With the file still checked out, change it server-side (`echo x >> file` over the shell). Re-open it from the panel → the reload prompt appears. Choose **Keep the local copy** → editor comes forward, local text intact. Re-open again, choose **Reload from server** → the editor reports the file changed on disk, the server content is there, and no upload fires afterwards.
4. **Opening tab closed.** With two tabs to the host and a file checked out, close the tab it was opened from. Save in the editor → the upload goes through over the surviving tab.
5. **Last tab closed.** Close the remaining tab → the temp dir is gone; a save from the still-open editor raises the "Could not save" modal naming the temp path.

If any step fails, fix it and re-run `npx tsc --noEmit -p tsconfig.json && npm test && npm run build` before continuing.

- [ ] **Step 3: Update AGENTS.md**

In the Layout section, replace the `local-edit.service.ts` description with:

```
  local-edit.service.ts  LocalEditService (providedIn:root) — "edit locally": download→temp, spawn
                      editor (configured exe or OS default), fs.watch → debounced re-upload + chmod;
                      one temp copy per server+path (reopen reuses it, offers reload when the remote
                      moved), session registry so a save survives the opening tab closing;
                      Windows .txt-handler auto-detect (UserChoice registry) for settings prefill
```

In the Status section, replace the last bullet with:

```
- Edited files are tracked in `LocalEditService.openEdits`, keyed by server (`user@host:port`)
  plus remote path: re-opening a checked-out file reuses its temp copy instead of downloading a
  second one, and offers a reload when the remote copy moved since our last transfer. A save
  resolves its SFTP handle from a live-session registry, so closing the tab that opened the file
  does not orphan it — the temp copy is dropped only when the last session to that server goes.
  Temp copies are wiped on window unload, a re-upload whose remote mtime moved since the last
  transfer prompts before overwriting, and a failed re-upload raises a modal naming the temp path.
  Still open in issue #5: no polling (detection happens on save and on re-open), and no
  "keep both" conflict option.
```

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs: describe local-edit lifecycle tracking"
```
