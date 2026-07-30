# Local-tab explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing SFTP panel on local terminal tabs, backed by the local filesystem, as a full file explorer.

**Architecture:** A `LocalFsSession` class duck-types tabby-ssh's `SFTPSession` over node `fs`. The panel calls only eleven of its methods, so implementing those leaves all ~40 call sites in `panel.component.ts` untouched. Local paths are presented as *virtual posix* paths (`/C:/Users/x`) and converted to native only at the fs boundary, because the panel imports `posix as path` and `posix.resolve` mishandles native Windows roots. Four behaviours that genuinely differ locally (open-in-editor, copy/move, delete-to-trash, chmod/owner visibility) live in `local-ops.ts` rather than as inline branches in a 1840-line component.

**Tech Stack:** TypeScript, Angular 15 (JIT, via Tabby's DI), webpack + ts-loader (`transpileOnly`), `node:test` via `tsx`, node `fs`/`os`/`path` and Electron's `shell` reached through `(window as any).require`.

**Spec:** `docs/superpowers/specs/2026-07-30-local-tab-explorer-design.md`

## Global Constraints

- Branch: `local-tab-explorer`. Already created and checked out.
- **Node builtins and Electron modules are reached via `const req = (window as any).require`**, never bare `import`. This is the established pattern (`local-edit.service.ts:7-8`) and the only one that resolves Tabby's running modules rather than a plugin-local copy. Consequence: any module with `(window as any).require` at top level **cannot be imported by a `node:test` unit** (`window` is undefined there → `ReferenceError`). Pure, testable helpers therefore live in a `window`-free module.
- Every task ends with all three of: `npm test`, `npx tsc --noEmit -p tsconfig.json`, `npm run build`. The build does **not** type-check (`transpileOnly: true`), so `tsc --noEmit` is not optional.
- Neither the build nor the tests verify Angular templates (JIT, no AOT). Template errors surface as `NG0302` at first render only. Tasks that touch the template say so explicitly.
- Locale catalogs live at the **repo root** (`locale/*.po`), not under `src/`. `src/i18n.test.ts` enforces that all seven catalogs (de-DE, zh-CN, ru-RU, es-ES, fr-FR, ja-JP, pt-BR) have identical msgid sets and no empty msgstr. Adding a msgid to one means adding it to all seven.
- Never use an apostrophe (`'`) in a msgid — it is a MessageFormat escape character and mangles the English fallback. Reword instead.
- Do not add runtime `dependencies` to `package.json`. The package ships only `dist/index.js`.
- Existing unit count is 36 (sftp-util 30 + logic 4 + i18n 2). Each task that adds tests states the new expected total.

---

### Task 1: Virtual path helpers

Pure functions, no `fs`, no `window` — so they are directly unit-testable. This is a deliberate split from the spec, which sketched them inside `local-fs.session.ts`; that module needs `(window as any).require` at top level and would be unimportable under `node:test`.

**Files:**
- Create: `src/local-path.ts`
- Test: `src/local-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isWin: boolean` — `process.platform === 'win32'`, evaluated once at module load.
  - `toNativePath(virtual: string, win?: boolean): string`
  - `toVirtualPath(native: string, win?: boolean): string`
  - `isVirtualRoot(p: string, win?: boolean): boolean`
  - `driveRoots(exists: (nativePath: string) => boolean): string[]`

  The `win` parameter defaults to `isWin` and exists so both platform flavours are testable from one machine. Callers outside tests always omit it.

- [ ] **Step 1: Write the failing test**

Create `src/local-path.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toNativePath, toVirtualPath, isVirtualRoot, driveRoots } from './local-path'

test('toNativePath converts virtual posix to native win32', () => {
    assert.equal(toNativePath('/C:/Users/x', true), 'C:\\Users\\x')
    assert.equal(toNativePath('/C:/Users/x/file.txt', true), 'C:\\Users\\x\\file.txt')
    // A bare drive must keep its trailing separator: 'C:' alone is DRIVE-RELATIVE on
    // Windows and would resolve against that drive's own cwd, not its root.
    assert.equal(toNativePath('/C:', true), 'C:\\')
    assert.equal(toNativePath('/', true), '\\')
})

test('toNativePath is identity on posix', () => {
    assert.equal(toNativePath('/home/x', false), '/home/x')
    assert.equal(toNativePath('/', false), '/')
})

test('toVirtualPath converts native win32 to virtual posix', () => {
    assert.equal(toVirtualPath('C:\\Users\\x', true), '/C:/Users/x')
    assert.equal(toVirtualPath('C:\\', true), '/C:')
})

test('toVirtualPath is identity on posix', () => {
    assert.equal(toVirtualPath('/home/x', false), '/home/x')
})

test('path conversion round-trips', () => {
    for (const p of ['/C:/Users/x', '/C:/a b/c', '/D:']) {
        assert.equal(toVirtualPath(toNativePath(p, true), true), p)
    }
    for (const p of ['/home/x', '/']) {
        assert.equal(toVirtualPath(toNativePath(p, false), false), p)
    }
})

test('isVirtualRoot is win32-only and matches slashes only', () => {
    assert.equal(isVirtualRoot('/', true), true)
    assert.equal(isVirtualRoot('/C:', true), false)
    assert.equal(isVirtualRoot('/C:/x', true), false)
    // On posix '/' is a real directory, so it must NOT be treated as the synthetic root.
    assert.equal(isVirtualRoot('/', false), false)
})

test('driveRoots probes A: through Z: and returns virtual paths', () => {
    const probed: string[] = []
    const roots = driveRoots(p => { probed.push(p); return p === 'C:\\' || p === 'Z:\\' })
    assert.deepEqual(roots, ['/C:', '/Z:'])
    assert.equal(probed.length, 26)
    assert.equal(probed[0], 'A:\\')
    assert.equal(probed[25], 'Z:\\')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/local-path.test.ts`
Expected: FAIL — cannot resolve `./local-path`.

- [ ] **Step 3: Write minimal implementation**

Create `src/local-path.ts`:

```ts
// The panel speaks posix paths everywhere (`panel.component.ts:1` imports `posix as path`),
// and posix.resolve() does not recognise `C:/` as a root: it prepends process.cwd() and
// returns garbage. So local paths are PRESENTED as virtual posix paths rooted at '/', and
// converted to native only at the fs boundary:
//     win32:  /C:/Users/x  <->  C:\Users\x     ('/' = the synthetic drive-list root)
//     posix:  /home/x      <->  /home/x        (identity, zero conversion)
// `win` is a parameter only so both flavours are testable from one machine.

export const isWin = process.platform === 'win32'

export function toNativePath (virtual: string, win = isWin): string {
    if (!win) { return virtual }
    const v = virtual.replace(/^\/+/, '').replace(/\//g, '\\')
    if (v === '') { return '\\' }
    // 'C:' alone is drive-relative on Windows — keep the root separator.
    return /^[A-Za-z]:$/.test(v) ? v + '\\' : v
}

export function toVirtualPath (native: string, win = isWin): string {
    if (!win) { return native }
    const v = '/' + native.replace(/\\/g, '/').replace(/^\/+/, '')
    return v.length > 1 ? v.replace(/\/+$/, '') : v
}

/** True only for the synthetic win32 root whose listing is the drive list. */
export function isVirtualRoot (p: string, win = isWin): boolean {
    return win && /^\/+$/.test(p)
}

/** Drive roots as virtual paths, e.g. ['/C:', '/D:']. `exists` is injected so this is
 *  testable without touching a real filesystem. 26 probes, instant, and no dependency on
 *  the deprecated `wmic`. */
export function driveRoots (exists: (nativePath: string) => boolean): string[] {
    const out: string[] = []
    for (let c = 65; c <= 90; c++) {
        const letter = String.fromCharCode(c)
        if (exists(`${letter}:\\`)) { out.push(`/${letter}:`) }
    }
    return out
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npm test`
Expected: PASS, 43 tests (36 existing + 7 new).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npm run build`
Expected: emits `dist/index.js` without errors.

- [ ] **Step 5: Commit**

```bash
git add src/local-path.ts src/local-path.test.ts
git commit -m "feat: add virtual posix path helpers for local filesystem browsing"
```

---

### Task 2: The filesystem session adapter

**Files:**
- Create: `src/local-fs.session.ts`
- Test: `src/local-fs.session.test.ts`

**Interfaces:**
- Consumes: `toNativePath`, `toVirtualPath`, `isVirtualRoot`, `driveRoots` from Task 1; `SFTPFile` type from `tabby-ssh`.
- Produces: `class LocalFsSession` with the methods the panel calls on `this.sftp`:
  - `readdir(p: string): Promise<SFTPFile[]>`
  - `stat(p: string): Promise<SFTPFile>`
  - `readlink(p: string): Promise<string>`
  - `open(p: string, mode: number): Promise<{ read(): Promise<Uint8Array>, write(c: Uint8Array): Promise<void>, close(): Promise<void> }>`
  - `mkdir(p: string): Promise<void>`
  - `rmdir(p: string): Promise<void>`
  - `unlink(p: string): Promise<void>`
  - `rename(from: string, to: string): Promise<void>`
  - `chmod(p: string, mode: string | number): Promise<void>`
  - `upload(p: string, transfer: FileUpload): Promise<void>`
  - `download(p: string, transfer: FileDownload): Promise<void>`

  All path arguments and all `SFTPFile.fullPath` values are **virtual** paths.

- [ ] **Step 1: Write the failing test**

Create `src/local-fs.session.test.ts`. Note the `globalThis.window` shim in step 1 of the test — the module reads `(window as any).require` at load time, so the test must provide it *before* the dynamic import.

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { toVirtualPath } from './local-path'

// The adapter reaches node builtins through Electron's `window.require` (the only pattern
// that resolves Tabby's running modules). Shim it before importing the module under test.
;(globalThis as any).window = { require: createRequire(import.meta.url) }
const { LocalFsSession } = await import('./local-fs.session')

const withTempDir = async (fn: (dir: string, vdir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'sftp-panel-test-'))
    try { await fn(dir, toVirtualPath(dir)) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('readdir reports names, sizes, dir flags and virtual full paths', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'hello')
        const s = new LocalFsSession()
        await s.mkdir(vdir + '/sub')
        const entries = (await s.readdir(vdir)).sort((x: any, y: any) => x.name.localeCompare(y.name))
        assert.equal(entries.length, 2)
        assert.equal(entries[0].name, 'a.txt')
        assert.equal(entries[0].fullPath, vdir + '/a.txt')
        assert.equal(entries[0].isDirectory, false)
        assert.equal(entries[0].size, 5)
        // The panel expects the file-type bits in `mode`, as readdir carries them everywhere else.
        assert.ok((entries[0].mode & 0o170000) !== 0, 'mode must carry file-type bits')
        assert.equal(entries[1].name, 'sub')
        assert.equal(entries[1].isDirectory, true)
    })
})

test('stat, rename, chmod and unlink round-trip', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'hello')
        const s = new LocalFsSession()
        const st = await s.stat(vdir + '/a.txt')
        assert.equal(st.size, 5)
        assert.equal(st.isDirectory, false)
        assert.equal(st.isSymlink, false)
        assert.ok(st.modified instanceof Date && st.modified.getTime() > 0)

        await s.rename(vdir + '/a.txt', vdir + '/b.txt')
        assert.deepEqual((await s.readdir(vdir)).map((e: any) => e.name), ['b.txt'])

        if (process.platform !== 'win32') {
            await s.chmod(vdir + '/b.txt', 0o600)
            assert.equal((await s.stat(vdir + '/b.txt')).mode & 0o777, 0o600)
        }

        await s.unlink(vdir + '/b.txt')
        assert.deepEqual(await s.readdir(vdir), [])
    })
})

test('mkdir and rmdir round-trip', async () => {
    await withTempDir(async (_dir, vdir) => {
        const s = new LocalFsSession()
        await s.mkdir(vdir + '/d')
        assert.equal((await s.stat(vdir + '/d')).isDirectory, true)
        await s.rmdir(vdir + '/d')
        assert.deepEqual(await s.readdir(vdir), [])
    })
})

test('download streams the file through the transfer interface', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.bin'), 'abcdef')
        const chunks: Uint8Array[] = []
        let closed = false
        const transfer: any = {
            write: async (b: Uint8Array) => { chunks.push(b) },
            close: () => { closed = true },
            cancel: () => { throw new Error('should not cancel') },
        }
        await new LocalFsSession().download(vdir + '/a.bin', transfer)
        assert.equal(Buffer.concat(chunks.map(c => Buffer.from(c))).toString(), 'abcdef')
        assert.equal(closed, true)
    })
})

test('upload writes the transfer stream atomically', async () => {
    await withTempDir(async (dir, vdir) => {
        const parts = [Buffer.from('abc'), Buffer.from('def'), Buffer.alloc(0)]
        let i = 0
        let closed = false
        const transfer: any = {
            read: async () => new Uint8Array(parts[i++]),
            close: () => { closed = true },
            cancel: () => { throw new Error('should not cancel') },
        }
        await new LocalFsSession().upload(vdir + '/out.bin', transfer)
        assert.equal(readFileSync(join(dir, 'out.bin')).toString(), 'abcdef')
        assert.equal(closed, true)
        // The temp file must not survive.
        assert.deepEqual((await new LocalFsSession().readdir(vdir)).map((e: any) => e.name), ['out.bin'])
    })
})

test('download cancels the transfer and rethrows when the file is missing', async () => {
    await withTempDir(async (_dir, vdir) => {
        let cancelled = false
        const transfer: any = { write: async () => {}, close: () => {}, cancel: () => { cancelled = true } }
        await assert.rejects(() => new LocalFsSession().download(vdir + '/nope', transfer))
        assert.equal(cancelled, true)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/local-fs.session.test.ts`
Expected: FAIL — cannot resolve `./local-fs.session`.

- [ ] **Step 3: Write minimal implementation**

Create `src/local-fs.session.ts`:

```ts
import type { SFTPFile } from 'tabby-ssh'
import type { FileUpload, FileDownload } from 'tabby-core'
import { toNativePath, toVirtualPath, isVirtualRoot, driveRoots, isWin } from './local-path'

// Node builtins via Electron's require — see the window.require note in AGENTS.md.
const req = (window as any).require
const fs = req('fs'), fsp = fs.promises

const CHUNK = 256 * 1024   // same read size russh's SFTPFileHandle uses

// Duck-types tabby-ssh's SFTPSession (_tabby-ref/tabby-ssh/src/session/sftp.ts) over the
// local filesystem. The panel calls exactly the eleven methods below on `this.sftp`, so
// implementing them here leaves every call site in panel.component.ts unchanged.
// All paths in and out are VIRTUAL posix paths (see local-path.ts).
export class LocalFsSession {
    async readdir (p: string): Promise<SFTPFile[]> {
        if (isVirtualRoot(p)) { return this.drives() }
        const native = toNativePath(p)
        const names: string[] = await fsp.readdir(native)
        const out = await Promise.all(names.map(n => this.entry(p, n)))
        // Entries can vanish between readdir and lstat — drop them rather than fail the listing.
        return out.filter(Boolean) as SFTPFile[]
    }

    async stat (p: string): Promise<SFTPFile> {
        const native = toNativePath(p)
        const st = await fsp.stat(native)          // follows symlinks, like SFTP stat
        const lst = await fsp.lstat(native).catch(() => st)
        return this.toFile(p, st, lst.isSymbolicLink())
    }

    async readlink (p: string): Promise<string> {
        const target: string = await fsp.readlink(toNativePath(p))
        // Absolute targets become virtual; relative ones stay relative — the panel feeds the
        // result to posix.resolve(this.path, target), which needs that distinction intact.
        const rel = isWin ? !/^([A-Za-z]:|\\\\)/.test(target) : !target.startsWith('/')
        return rel ? target.replace(/\\/g, '/') : toVirtualPath(target)
    }

    // ponytail: the russh OPEN_* bit flags are ignored. The panel's only call is
    // openCreateFileModal() creating an empty file, so this always opens exclusively for
    // write — an existing file surfaces as EEXIST in the panel log instead of being
    // truncated, which is the safer direction for a "New file" action.
    async open (p: string, _mode: number): Promise<{ read(): Promise<Uint8Array>, write(c: Uint8Array): Promise<void>, close(): Promise<void> }> {
        const h = await fsp.open(toNativePath(p), 'wx')
        return {
            async read () { return new Uint8Array(0) },
            async write (c: Uint8Array) { await h.write(c) },
            async close () { await h.close() },
        }
    }

    async mkdir (p: string): Promise<void> { await fsp.mkdir(toNativePath(p)) }
    async rmdir (p: string): Promise<void> { await fsp.rmdir(toNativePath(p)) }
    async unlink (p: string): Promise<void> { await fsp.unlink(toNativePath(p)) }
    async rename (from: string, to: string): Promise<void> { await fsp.rename(toNativePath(from), toNativePath(to)) }
    async chmod (p: string, mode: string | number): Promise<void> { await fsp.chmod(toNativePath(p), mode) }

    // Streaming through the same FileUpload/FileDownload interface is what keeps drag-in,
    // drag-out, the transfer log rows, the progress bars and the per-row Stop button working
    // with no panel changes at all.
    async download (p: string, transfer: FileDownload): Promise<void> {
        try {
            const h = await fsp.open(toNativePath(p), 'r')
            try {
                const buf = Buffer.allocUnsafe(CHUNK)
                while (true) {
                    const { bytesRead } = await h.read(buf, 0, CHUNK, null)
                    if (!bytesRead) { break }
                    // Copy: `buf` is reused on the next iteration.
                    await transfer.write(new Uint8Array(buf.subarray(0, bytesRead)))
                }
            } finally { await h.close() }
            transfer.close()
        } catch (e) {
            transfer.cancel()
            throw e
        }
    }

    // Mirrors SFTPSession.upload: write to a sibling temp file, then swap it in, so a
    // cancelled or failed transfer never leaves a truncated destination.
    async upload (p: string, transfer: FileUpload): Promise<void> {
        const native = toNativePath(p)
        const temp = native + '.tabby-upload'
        try {
            const h = await fsp.open(temp, 'w')
            try {
                while (true) {
                    const chunk = await transfer.read()
                    if (!chunk.length) { break }
                    await h.write(chunk)
                }
            } finally { await h.close() }
            await fsp.rm(native, { force: true })
            await fsp.rename(temp, native)
            transfer.close()
        } catch (e) {
            transfer.cancel()
            await fsp.rm(temp, { force: true }).catch(() => null)
            throw e
        }
    }

    private async entry (dir: string, name: string): Promise<SFTPFile | null> {
        const full = dir.replace(/\/+$/, '') + '/' + name
        try {
            // lstat, not stat: SFTP readdir does not follow symlinks either, and following
            // them here would hang on a link into a dead network mount.
            const st = await fsp.lstat(toNativePath(full))
            return this.toFile(full, st, st.isSymbolicLink())
        } catch {
            return null
        }
    }

    private toFile (virtual: string, st: any, isSymlink: boolean): SFTPFile {
        const name = virtual.split('/').filter(Boolean).pop() ?? virtual
        return {
            name,
            fullPath: virtual,
            isDirectory: st.isDirectory(),
            isSymlink,
            mode: st.mode,          // already carries the file-type bits (0o100644)
            size: st.size,
            modified: st.mtime,
        }
    }

    private drives (): SFTPFile[] {
        return driveRoots(p => fs.existsSync(p)).map(v => ({
            name: v.slice(1),       // '/C:' -> 'C:'
            fullPath: v,
            isDirectory: true,
            isSymlink: false,
            mode: 0o040755,
            size: 0,
            modified: new Date(0),
        }))
    }
}
```

- [ ] **Step 4: Run tests, type-check and build**

Run: `npm test`
Expected: PASS, 49 tests (43 + 6 new).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npm run build`
Expected: emits `dist/index.js` without errors.

- [ ] **Step 5: Commit**

```bash
git add src/local-fs.session.ts src/local-fs.session.test.ts
git commit -m "feat: add a filesystem session that duck-types SFTPSession"
```

---

### Task 3: Config flag and settings checkbox

**Files:**
- Modify: `src/config.ts:19` (add the key next to the other booleans)
- Modify: `src/settings.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.store.sftpPanel.localTabs: boolean`, default `true`. Read by Task 4 (mount gating) and nothing else.

- [ ] **Step 1: Add the config default**

In `src/config.ts`, inside `sftpPanel`, directly after the `showHidden` line:

```ts
            localTabs: true,          // also mount the panel on local terminal tabs (local filesystem)
```

- [ ] **Step 2: Add the settings checkbox**

Read `src/settings.ts` first and match the surrounding markup exactly — it is a Tabby settings tab using the same `.form-line` / `toggle` pattern throughout. Add one entry near the other panel-behaviour toggles:

```html
        <div class="form-line">
          <div class="header">
            <div class="title">{{ 'Show the panel on local terminal tabs' | translate }}</div>
            <div class="description">{{ 'Adds the file browser to local shells, backed by the local filesystem.' | translate }}</div>
          </div>
          <toggle [(ngModel)]="config.store.sftpPanel.localTabs" (ngModelChange)="config.save()"></toggle>
        </div>
```

The two new msgids are translated in Task 7. Until then the settings tab shows English in non-English Tabby, which is expected.

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: PASS, 49 tests (unchanged — no new units; `i18n.test.ts` only compares catalogs to each other and is unaffected by an untranslated msgid).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npm run build`
Expected: emits `dist/index.js` without errors.

**Template risk:** this edits a template. `toggle` and the `translate` pipe are both already used elsewhere in `settings.ts`, so no new directive comes into scope — but confirm the settings tab still renders in a running Tabby before moving on.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/settings.ts
git commit -m "feat: add the localTabs config flag and its settings toggle"
```

---

### Task 4: Mount wiring and session plumbing

The panel starts appearing on local tabs after this task and can browse, but delete/copy/move still take the SFTP path (Task 5) and the UI still shows SFTP-only affordances (Task 6).

**Files:**
- Modify: `src/mount.service.ts:64-91` (tab predicates), `:111-115` (`ensureMounted`), `:168-171` (initial session), `:215-223` (`updateSession`, config subscription), constructor
- Modify: `src/panel.component.ts:29-35` (session structural type), `:474-538` (`setSession`, `openIfReady`, `resolveHome`)

**Interfaces:**
- Consumes: `LocalFsSession` (Task 2), `toVirtualPath` (Task 1), `config.store.sftpPanel.localTabs` (Task 3).
- Produces:
  - `mount.service.ts` private: `isLocalTab(tab): boolean`, `isFsTab(tab): boolean`, `fsPanes(topTab): any[]`, `focusedFsPane(topTab): any | null`, `sessionFor(pane): any | null`, `localWrapper(pane): any`, `syncMounts(): void`. `sshPanes`/`focusedSSHPane` are renamed to `fsPanes`/`focusedFsPane`; `isSSHTab` stays.
  - The local session wrapper object: `{ local: true, openSFTP(): Promise<LocalFsSession>, getCwd(): Promise<string | null> }`.
  - `panel.component.ts` public getter: `get isLocal(): boolean` — used by Tasks 5 and 6.

- [ ] **Step 1: Extend the panel's session type and add the `isLocal` getter**

In `src/panel.component.ts`, extend `SSHSessionLike` (currently at `:29-35`) with the two optional fields the local wrapper supplies:

```ts
interface SSHSessionLike {
    openSFTP(): Promise<SFTPSession>
    willDestroy$?: { subscribe(fn: () => void): { unsubscribe(): void } }
    profile?: { options: { host: string, port: number, user: string } }
    // Set only by the mount service's local-tab wrapper: marks a filesystem-backed
    // session and yields the terminal's current working directory (native path).
    local?: boolean
    getCwd?: () => Promise<string | null>
}
```

Add the getter next to the other accessors in the component class (near `goUp()` at `:949` is fine):

```ts
    /** True when this panel is backed by the local filesystem (a local terminal tab)
     *  rather than SFTP. Drives the behaviour branches in local-ops and the template. */
    get isLocal (): boolean { return this.session?.local === true }
```

- [ ] **Step 2: Branch `openIfReady` and `resolveHome`**

In `openIfReady()` (`:496`), the shell-channel wait and the local-edit registration are SSH-only. A local session has no `shell` field, so the existing loop would burn its full 5s cap (`:508`) plus the 400ms MotD grace before the panel worked. Replace the body between `this.opening = true` and `await this.navigate(target)` so that:

```ts
        this.opening = true
        try {
            if (!this.isLocal) {
                // (existing comment block about the shell channel and the MotD stays here)
                for (let i = 0; i < 100 && !this.shellSession?.shell; i++) {
                    await new Promise(r => setTimeout(r, 50))
                }
                await new Promise(r => setTimeout(r, 400))
            }
            this.sftp = await this.session.openSFTP()
            // The local-edit registry is keyed by user@host:port and exists to route
            // re-uploads to a live SSH session — meaningless for a local filesystem.
            if (!this.isLocal) { this.localEdit.registerSession(this.sftp, this.session.profile) }
```

Leave the rest of the method (`let target = this.path` onward, `:524-537`) untouched.

Then extend `resolveHome()` (`:570`) so the "home" a local panel resolves to is the terminal's working directory:

```ts
    private async resolveHome (): Promise<string | null> {
        if (this.isLocal) {
            // The terminal's cwd, taken once at open; falls back to the OS home. Native
            // path in, virtual path out.
            const cwd = await this.session?.getCwd?.().catch(() => null) ?? null
            return toVirtualPath(cwd || (window as any).require('os').homedir())
        }
        const out = await this.exec('pwd')
        if (out === null) { return null }
        const home = out.trim().split('\n').pop()?.trim() ?? ''
        return home.startsWith('/') ? home : null
    }
```

Add `toVirtualPath` to the imports at the top of the file:

```ts
import { toVirtualPath } from './local-path'
```

This needs no change to `startNeedsHome`/`resolveStartPath`: `startDirectory` defaults to `'~'`, so `startNeedsHome` is true and the cwd wins. A user who has set an absolute `startDirectory` gets it on local tabs too; when it does not exist there, the existing fallback at `:531-532` navigates to `'/'` — the drive list on Windows.

- [ ] **Step 3: Rewire the mount service**

In `src/mount.service.ts`:

Add the import and a per-pane wrapper cache as a field next to `mounts`/`watched`:

```ts
import { LocalFsSession } from './local-fs.session'
```
```ts
    // One stable wrapper per local pane. Stability matters: setSession() treats a
    // different object as a reconnect and drops the open handle, so handing out a fresh
    // wrapper on every focus change would reopen the listing each time.
    private localSessions = new WeakMap<object, any>()
```

Replace the predicate block at `:64-81` with:

```ts
    private isSSHTab (tab: any): boolean {
        return !!tab && typeof tab.openSFTP === 'function' && 'sshSession' in tab
    }

    // A local terminal tab (tabby-local sets profile.type — see _tabby-ref/tabby-local/
    // src/profiles.ts:42). Gated on the config flag so turning it off removes the panel.
    private isLocalTab (tab: any): boolean {
        return !!tab && tab.profile?.type === 'local' && !!this.config.store?.sftpPanel?.localTabs
    }

    private isFsTab (tab: any): boolean {
        return this.isSSHTab(tab) || this.isLocalTab(tab)
    }

    private allTabs (topTab: any): any[] {
        return typeof topTab.getAllTabs === 'function' ? topTab.getAllTabs() : [topTab]
    }

    private fsPanes (topTab: any): any[] {
        return this.allTabs(topTab).filter(t => this.isFsTab(t))
    }

    // The pane whose filesystem the panel should show: the focused one, else the first.
    // In a mixed split (SSH + local) the focused pane therefore wins.
    private focusedFsPane (topTab: any): any | null {
        const f = typeof topTab.getFocusedTab === 'function' ? topTab.getFocusedTab() : topTab
        if (this.isFsTab(f)) { return f }
        return this.fsPanes(topTab)[0] ?? null
    }

    // The session object to hand the panel for a pane: the live SSHSession, or a stable
    // filesystem wrapper that duck-types just enough of it.
    private sessionFor (pane: any): any | null {
        if (this.isSSHTab(pane)) { return pane.sshSession ?? null }
        if (this.isLocalTab(pane)) { return this.localWrapper(pane) }
        return null
    }

    private localWrapper (pane: any): any {
        let w = this.localSessions.get(pane)
        if (!w) {
            w = {
                local: true,
                openSFTP: async () => new LocalFsSession(),
                getCwd: () => pane.session?.getWorkingDirectory?.() ?? Promise.resolve(null),
            }
            this.localSessions.set(pane, w)
        }
        return w
    }
```

Replace the three remaining `sshPanes`/`focusedSSHPane` call sites:

- `:89` inside `splitTabEl`: `this.focusedSSHPane(topTab)` → `this.focusedFsPane(topTab)`
- `:113` inside `ensureMounted`: `if (!this.sshPanes(topTab).length) { return }` → `if (!this.fsPanes(topTab).length) { return }`
- `:222`: `for (const p of this.sshPanes(topTab))` → `for (const p of this.fsPanes(topTab))`

Replace the initial-session block at `:169-171` with:

```ts
        const pane0 = this.focusedFsPane(topTab)
        ref.instance.session = this.sessionFor(pane0)
        ref.instance.shellSession = pane0?.session ?? null
```

Replace `updateSession` at `:215-219` with:

```ts
        const updateSession = () => {
            const pane = this.focusedFsPane(topTab)
            const s = pane && this.sessionFor(pane)
            if (s) { ref.instance.shellSession = pane?.session ?? null; ref.instance.setSession(s) }
        }
```

- [ ] **Step 4: Mount and unmount on config changes**

Toggling `localTabs` must add or remove panels without a restart. In the constructor (`:44-46`), replace the two subscriptions plus add one:

```ts
        this.sweepTabs()
        this.app.tabOpened$.subscribe(() => this.sweepTabs())
        this.app.tabsChanged$.subscribe(() => this.sweepTabs())
        this.config.changed$.subscribe(() => this.syncMounts())
```

And add:

```ts
    // localTabs was toggled off → drop panels from tabs that no longer qualify; toggled
    // on → mount the ones that now do. (Layout changes are handled per-mount already.)
    private syncMounts (): void {
        for (const top of this.app.tabs) {
            if (this.mounts.get(top) && !this.fsPanes(top).length) { this.unmount(top) }
        }
        this.sweepTabs()
    }
```

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: PASS, 49 tests (unchanged — this task is wiring; its behaviour is only observable in a running Tabby).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output. This is the real gate for this task — the rename touches several call sites.

Run: `npm run build`
Expected: emits `dist/index.js` without errors.

**Manual check in a running Tabby** (fully restart it — plugins scan only at startup):
1. Open a local terminal tab → the collapsed strip appears; hovering it lists the shell's working directory.
2. On Windows, navigate to `/` via the path field → the drive list appears; entering a drive lists it.
3. Double-click folders and `..` → navigation works, breadcrumb path is `/C:/...` shaped.
4. Split a tab into one SSH pane and one local pane → focusing each pane switches the panel's listing.
5. Turn `localTabs` off in the settings → the strip disappears from local tabs, stays on SSH tabs.

- [ ] **Step 6: Commit**

```bash
git add src/mount.service.ts src/panel.component.ts
git commit -m "feat: mount the panel on local tabs against the local filesystem"
```

---

### Task 5: Local copy, move and trash

**Files:**
- Create: `src/local-ops.ts`
- Test: `src/local-ops.test.ts`
- Modify: `src/panel.component.ts:1168-1196` (`applyServerMove`, `applyServerCopy`), `:1610-1655` (`deleteSelected`, `deleteRecursive`)

**Interfaces:**
- Consumes: `toNativePath` (Task 1), `isLocal` (Task 4).
- Produces, all taking **virtual** paths and returning `null` on success or an error message string on failure:
  - `localCopy(srcVirtual: string, destDirVirtual: string): Promise<string | null>`
  - `localMove(srcVirtual: string, destDirVirtual: string): Promise<string | null>`
  - `localTrash(virtual: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

Create `src/local-ops.test.ts`. `localTrash` is deliberately not unit-tested — it delegates to Electron's shell, which does not exist under `node:test`; that is why `local-ops.ts` requires `electron` lazily inside the function rather than at module load.

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { toVirtualPath } from './local-path'

;(globalThis as any).window = { require: createRequire(import.meta.url) }
const { localCopy, localMove } = await import('./local-ops')

const withTempDir = async (fn: (dir: string, vdir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'sftp-panel-ops-'))
    try { await fn(dir, toVirtualPath(dir)) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('localCopy copies a file into the destination directory', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'hello')
        mkdirSync(join(dir, 'dest'))
        assert.equal(await localCopy(vdir + '/a.txt', vdir + '/dest'), null)
        assert.equal(readFileSync(join(dir, 'dest', 'a.txt')).toString(), 'hello')
        assert.ok(existsSync(join(dir, 'a.txt')), 'source must survive a copy')
    })
})

test('localCopy copies a directory tree recursively', async () => {
    await withTempDir(async (dir, vdir) => {
        mkdirSync(join(dir, 'tree', 'sub'), { recursive: true })
        writeFileSync(join(dir, 'tree', 'sub', 'deep.txt'), 'x')
        mkdirSync(join(dir, 'dest'))
        assert.equal(await localCopy(vdir + '/tree', vdir + '/dest'), null)
        assert.equal(readFileSync(join(dir, 'dest', 'tree', 'sub', 'deep.txt')).toString(), 'x')
    })
})

test('localMove relocates a file and removes the source', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'hello')
        mkdirSync(join(dir, 'dest'))
        assert.equal(await localMove(vdir + '/a.txt', vdir + '/dest'), null)
        assert.equal(readFileSync(join(dir, 'dest', 'a.txt')).toString(), 'hello')
        assert.equal(existsSync(join(dir, 'a.txt')), false)
    })
})

test('localCopy reports a message instead of throwing when the source is missing', async () => {
    await withTempDir(async (_dir, vdir) => {
        const err = await localCopy(vdir + '/nope', vdir)
        assert.ok(typeof err === 'string' && err.length > 0)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/local-ops.test.ts`
Expected: FAIL — cannot resolve `./local-ops`.

- [ ] **Step 3: Write minimal implementation**

Create `src/local-ops.ts`:

```ts
import { toNativePath } from './local-path'

const req = (window as any).require
const fs = req('fs'), fsp = fs.promises, nodePath = req('path')

// The three operations the panel does differently on a local tab. Each takes VIRTUAL paths
// and returns null on success or a message on failure, so the panel can log uniformly
// without a try/catch per call site.

/** Recursive copy of `src` INTO the directory `destDir`, keeping its basename. */
export async function localCopy (src: string, destDir: string): Promise<string | null> {
    const from = toNativePath(src)
    const to = nodePath.join(toNativePath(destDir), nodePath.basename(from))
    try {
        await fsp.cp(from, to, { recursive: true, errorOnExist: false, force: true })
        return null
    } catch (e: any) {
        return e?.message ?? String(e)
    }
}

/** Move `src` INTO the directory `destDir`. Falls back to copy-then-delete across volumes,
 *  where rename fails with EXDEV. */
export async function localMove (src: string, destDir: string): Promise<string | null> {
    const from = toNativePath(src)
    const to = nodePath.join(toNativePath(destDir), nodePath.basename(from))
    try {
        await fsp.rename(from, to)
        return null
    } catch (e: any) {
        if (e?.code !== 'EXDEV') { return e?.message ?? String(e) }
        const copyErr = await localCopy(src, destDir)
        if (copyErr) { return copyErr }
        try {
            await fsp.rm(from, { recursive: true, force: true })
            return null
        } catch (e2: any) {
            return `copied, but could not remove the source: ${e2?.message ?? String(e2)}`
        }
    }
}

/** Move to the OS recycle bin. Deleting a local file has no remote copy to fall back on,
 *  and the OS already owns undo, so the panel never hard-deletes locally.
 *  `electron` is required lazily so the pure fs helpers above stay unit-testable. */
export async function localTrash (p: string): Promise<string | null> {
    try {
        await req('electron').shell.trashItem(toNativePath(p))
        return null
    } catch (e: any) {
        return e?.message ?? String(e)
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 53 tests (49 + 4 new).

- [ ] **Step 5: Branch the panel's move, copy and delete**

In `src/panel.component.ts`, add to the imports:

```ts
import { localCopy, localMove, localTrash } from './local-ops'
```

Replace `applyServerMove` (`:1168-1184`) and `applyServerCopy` (`:1186-1196`) so each takes the local path when `isLocal`. Keep every existing log message and the existing SSH behaviour verbatim:

```ts
    private async applyServerMove (targets: SFTPFile[], dest: string): Promise<void> {
        const failures: string[] = []
        for (const t of targets) {
            if (this.isLocal) {
                const err = await localMove(t.fullPath, dest)
                if (err) { failures.push(`${t.fullPath}: ${err}`) }
                continue
            }
            const target = path.join(dest, path.basename(t.fullPath))
            try {
                await this.sftp.rename(t.fullPath, target)
            } catch (e: any) {
                // ponytail: rename only; cross-mount move fails with EXDEV — reported, not silently cp+rm.
                failures.push(`${t.fullPath}: ${describeSftpError(e)}`)
            }
        }
        if (failures.length > 0) {
            this.log.log('error', this.translate.instant('Move failed on {n} item(s)', { n: failures.length }), failures.join('\n'))
        } else {
            this.log.log('info', this.translate.instant('Moved {n} item(s) to {dest}', { n: targets.length, dest }))
        }
    }

    private async applyServerCopy (targets: SFTPFile[], dest: string): Promise<void> {
        if (this.isLocal) {
            const failures: string[] = []
            for (const t of targets) {
                const err = await localCopy(t.fullPath, dest)
                if (err) { failures.push(`${t.fullPath}: ${err}`) }
            }
            if (failures.length > 0) {
                this.log.log('error', this.translate.instant('Copy failed'), failures.join('\n'))
            } else {
                this.log.log('info', this.translate.instant('Copied {n} item(s) to {dest}', { n: targets.length, dest }))
            }
            return
        }
        // No timeout (0) — cp -r on a big tree can outlast the default 5s exec cap.
        const out = await this.exec(buildCpCommand(targets.map(t => t.fullPath), dest), 0)
        if (out === null) {
            this.log.log('error', this.translate.instant('Copy failed'), 'exec failed')
        } else if (out.trim() !== '') {
            this.log.log('error', this.translate.instant('Copy failed'), out.trim())
        } else {
            this.log.log('info', this.translate.instant('Copied {n} item(s) to {dest}', { n: targets.length, dest }))
        }
    }
```

Also update the comment above `copyMoveSelected` (`:1144-1145`) to mention the local path:

```ts
    // Copy or move the selected items to a destination dir. SSH: move = per-item
    // sftp.rename(), copy = one `cp -r` over exec (SFTP has no server-side copy).
    // Local: fs.rename with an EXDEV fallback, and fs.cp(recursive) — see local-ops.ts.
```

Then branch the delete. `deleteRecursive` exists because SFTP's `rmdir` only removes empty directories; the recycle bin takes a whole tree in one call, so on local tabs the walk is skipped entirely. In `deleteSelected` (`:1622-1637`) replace the loop body's `deleteRecursive` call:

```ts
        for (const item of items) {
            // Live-updated log entry so a big tree visibly makes progress.
            const entry = this.log.log('info', this.translate.instant('Deleting {name}…', { name: item.name }))
            let count = 0
            try {
                if (this.isLocal) {
                    // The recycle bin takes a whole tree in one call — no walk needed.
                    const err = await localTrash(item.fullPath)
                    if (err) { throw new Error(err) }
                    count = 1
                } else {
                    await this.deleteRecursive(item, () => {
                        if (++count % 10 === 0) { this.log.update(entry, this.translate.instant('Deleting {name}… ({count} items)', { name: item.name, count })) }
                    })
                }
                this.log.update(entry, count > 1
                    ? this.translate.instant('Deleted {name} ({count} items)', { name: item.name, count })
                    : this.translate.instant('Deleted {name}', { name: item.name }))
            } catch (e: any) {
                this.log.update(entry, this.translate.instant('Delete failed: {name}', { name: item.name }))
                this.log.log('error', this.translate.instant('Delete failed: {name}', { name: item.name }), e?.message ?? String(e))
            }
        }
```

Leave the confirmation dialog (`:1613-1621`), the trailing `navigate`/`focusBody` (`:1638-1639`) and `deleteRecursive` itself unchanged.

- [ ] **Step 6: Verify**

Run: `npm test`
Expected: PASS, 53 tests.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npm run build`
Expected: emits `dist/index.js` without errors.

**Manual check in a running Tabby:** on a local tab, copy a file and a folder to another directory via Copy / Move…; move a file; delete a file and a folder and confirm both land in the recycle bin. Then confirm all three still work unchanged on an SSH tab.

- [ ] **Step 7: Commit**

```bash
git add src/local-ops.ts src/local-ops.test.ts src/panel.component.ts
git commit -m "feat: copy, move and trash local files through fs instead of SFTP"
```

---

### Task 6: Local-mode UI — open in editor, hidden SFTP affordances

The task with the most template surface and therefore the most `NG0302` exposure. No new pipes or directives are introduced, only `*ngIf` on existing elements and changes to methods the template already calls.

**Files:**
- Modify: `src/panel.component.ts:181` (spine), `:197-198` (upload buttons), `:256` (bulk Download), `:972-997` (`editFile`, `openWithDefault`), `:1000-1033` (`buildContextMenu`), plus `orderedCols()`

**Interfaces:**
- Consumes: `isLocal` (Task 4), `toNativePath` and `isWin` (Task 1), `LocalEditService.resolveEditor`/`spawnOpener`/`defaultOpener` (existing, `local-edit.service.ts:110`/`:132`/`:149`).
- Produces: no new exported surface. `orderedCols()` keeps its existing signature `(): Col[]` and gains local filtering.

- [ ] **Step 1: Open in the editor without a temp copy**

`LocalEditService.edit()` downloads to a temp dir, spawns the editor and watches for saves to re-upload — all pointless when the file the editor opens *is* the file. The `Opener` type is already `(path: string) => void | Promise<void>` and takes a plain path, so both openers are reused verbatim.

In `editFile` (`:972`), replace the single `this.localEdit.edit(...)` line's surrounding try block:

```ts
        const opener = exe ? this.localEdit.spawnOpener(exe) : this.localEdit.defaultOpener
        try {
            if (this.isLocal) {
                // The file is already local: spawn the editor on it directly. No temp copy,
                // no fs.watch, no re-upload, no conflict handling.
                await opener(toNativePath(item.fullPath))
            } else {
                await this.localEdit.edit(this.sftp, item, mode, size, opener)
            }
        } catch (e: any) {
            this.log.log('error', this.translate.instant('Could not open {name}', { name: item.name }), e?.message)
        }
```

And the same branch in `openWithDefault` (`:991`):

```ts
    async openWithDefault (item: SFTPFile, mode: number, size: number): Promise<void> {
        try {
            if (this.isLocal) {
                await this.localEdit.defaultOpener(toNativePath(item.fullPath))
            } else {
                await this.localEdit.edit(this.sftp, item, mode, size, this.localEdit.defaultOpener)
            }
        } catch (e: any) {
            this.log.log('error', this.translate.instant('Could not open {name}', { name: item.name }), e?.message)
        }
    }
```

Add `toNativePath` and `isWin` to the `./local-path` import added in Task 4:

```ts
import { toVirtualPath, toNativePath, isWin } from './local-path'
```

The large-file guard above (`:974-981`) stays as-is: opening a 2 GB binary in an editor is just as unwise locally.

- [ ] **Step 2: Hide the columns that carry no local information**

Owner and group come from parsing `ls -l` over an SSH exec channel (`:628-640`); locally only the current user's own name is resolvable, so a column of one name and blanks is worse than none. Permissions are real on posix but a lie on Windows, where `fs.chmod` only toggles the read-only bit.

Filter in `orderedCols()` (`:416`) — the one place both the header row (`:219`) and the data rows (`:237`) draw from, so header and cells stay in step:

```ts
    orderedCols (): Col[] {
        const cols = this.columnOrder.filter(k => this.col[k].visible)
        if (!this.isLocal) { return cols }
        // Owner/group are ls -l derived (SSH exec only). Permissions are meaningless on
        // Windows, where fs.chmod only toggles the read-only bit.
        return cols.filter(k => k !== 'owner' && k !== 'group' && !(isWin && k === 'perms'))
    }
```

`tableWidth()` (`:691-694`) currently sums `columnOrder` directly instead of going through `orderedCols()`, so without this next change the table would stay wider than the cells it renders — a horizontal scrollbar with nothing in it. Route it through the same filter (identical result on SSH tabs):

```ts
    tableWidth (): number {
        return this.orderedCols().reduce((w, k) => w + this.col[k].width, 0)
    }
```

- [ ] **Step 3: Hide the transfer affordances and relabel the spine**

Upload targets a remote host; on a local tab source and destination are the same filesystem. In the template:

`:197-198` — add `*ngIf="!isLocal"` to both upload buttons:

```html
      <button class="btn btn-link btn-sm" *ngIf="!isLocal" [title]="'Upload files' | translate" (click)="upload()"><i class="fas fa-upload"></i></button>
      <button class="btn btn-link btn-sm" *ngIf="!isLocal" [title]="'Upload folder' | translate" (click)="uploadFolder()"><i class="fas fa-folder-plus"></i></button>
```

`:256` — the bulk-bar Download button:

```html
        <button class="btn btn-sm btn-link" *ngIf="!isLocal" (click)="downloadSelected()"><i class="fas fa-download me-1"></i>{{ 'Download' | translate }}</button>
```

`:181` — the collapsed strip says "SFTP Panel", which is wrong on a local tab:

```html
    <div class="sp-spine" *ngIf="collapsed" [title]="(isLocal ? 'Files — hover to open' : 'SFTP Panel — hover to open') | translate"><span *ngIf="config.store.sftpPanel.spineLabel">{{ (isLocal ? 'Files' : 'SFTP Panel') | translate }}</span></div>
```

The two new msgids (`Files`, `Files — hover to open`) are translated in Task 7. Note the em dash, matching the existing string; and no apostrophes anywhere, per the MessageFormat constraint.

- [ ] **Step 4: Rebuild the context menu for local tabs**

`buildContextMenu` (`:1000`) opens by concatenating the sections from Tabby's `SFTPContextMenuItemProvider`s, which supply Download, Upload, Create directory and Delete — all written against an SFTP session. On a local tab, drop those sections and supply the two the panel would otherwise lose. Replace the top of the method:

```ts
    async buildContextMenu (item: SFTPFile): Promise<MenuItemOptions[]> {
        let items: MenuItemOptions[] = []
        if (!this.isLocal) {
            for (const section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(item, this as any)))) {
                items.push({ type: 'separator' })
                items = items.concat(section)
            }
            items = items.slice(1)
            // Drop Tabby's built-in "Edit locally" (it ignores our configured editor); add our own.
            // translate.instant gives the current-locale string, so this matches regardless of language.
            items = items.filter(i => i.label !== this.translate.instant('Edit locally'))
        }
```

Leave the `if (!item.isDirectory)` block (`:1010-1019`) unchanged, then extend the trailing item list (`:1020-1024`) so the local menu regains Delete and gates Permissions:

```ts
        items.push({ type: 'separator' })
        items.push({ label: this.translate.instant('Rename…'), click: () => this.renameItem(item) })
        items.push({ label: this.translate.instant('Copy / Move…'), click: () => this.copyMoveSelected(item) })
        items.push({ label: this.translate.instant('Copy path'), click: () => this.copyPath(item) })
        // Windows chmod only toggles the read-only bit, so an rwx grid there would be a lie.
        if (!(this.isLocal && isWin)) {
            items.push({ label: this.translate.instant('Permissions…'), click: () => this.openChmodDialog(item) })
        }
        // Tabby's SFTP providers supply Delete on remote tabs; local tabs have no providers.
        if (this.isLocal) {
            items.push({ type: 'separator' })
            items.push({ label: this.translate.instant('Delete'), click: () => this.deleteSelected() })
        }
```

`Delete` already resolves from Tabby's own catalogs, so it needs no new msgid.

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: PASS, 53 tests (unchanged — the changes are UI and are not unit-testable here).

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npm run build`
Expected: emits `dist/index.js` without errors.

**Manual check in a running Tabby — this task has the template risk, so do not skip it.** On a local tab: the strip reads "Files"; the two upload buttons and the bulk Download button are gone; the owner and group columns are gone (and Permissions too, on Windows); the header, cells and column widths still line up; right-click on a file offers Open, Rename…, Copy / Move…, Copy path, Delete (plus Permissions… on posix); double-clicking a text file opens it in the configured editor and saving writes straight through with no transfer entry in the log. Then open an SSH tab and confirm every one of those is unchanged there.

- [ ] **Step 6: Commit**

```bash
git add src/panel.component.ts
git commit -m "feat: adapt the panel UI for local tabs"
```

---

### Task 7: Translations and documentation

**Files:**
- Modify: `locale/de-DE.po`, `locale/zh-CN.po`, `locale/ru-RU.po`, `locale/es-ES.po`, `locale/fr-FR.po`, `locale/ja-JP.po`, `locale/pt-BR.po`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the msgids introduced in Tasks 3 and 6.
- Produces: nothing consumed by code.

- [ ] **Step 1: Add the four msgids to all seven catalogs**

Match the existing entry format in each file exactly (a `msgid`/`msgstr` pair; check whether the file carries `#:` reference comments and follow suit). `src/i18n.test.ts` fails if any catalog is missing one of these or leaves a msgstr empty. `SFTP Panel` and `SFTP Panel — hover to open` are **not** added — the former is a product name and the latter already ships.

| msgid | de-DE | zh-CN | ru-RU |
|---|---|---|---|
| `Files` | `Dateien` | `文件` | `Файлы` |
| `Files — hover to open` | `Dateien — zum Öffnen mit der Maus darüber` | `文件 — 悬停以打开` | `Файлы — наведите, чтобы открыть` |
| `Show the panel on local terminal tabs` | `Panel auch in lokalen Terminal-Tabs anzeigen` | `在本地终端标签页中显示面板` | `Показывать панель в локальных вкладках терминала` |
| `Adds the file browser to local shells, backed by the local filesystem.` | `Fügt den Dateibrowser lokalen Shells hinzu, gestützt auf das lokale Dateisystem.` | `将文件浏览器添加到本地 shell，基于本地文件系统。` | `Добавляет файловый браузер в локальные оболочки на основе локальной файловой системы.` |

| msgid | es-ES | fr-FR |
|---|---|---|
| `Files` | `Archivos` | `Fichiers` |
| `Files — hover to open` | `Archivos — pase el cursor para abrir` | `Fichiers — survolez pour ouvrir` |
| `Show the panel on local terminal tabs` | `Mostrar el panel en las pestañas de terminal local` | `Afficher le panneau dans les onglets de terminal local` |
| `Adds the file browser to local shells, backed by the local filesystem.` | `Añade el explorador de archivos a las shells locales, basado en el sistema de archivos local.` | `Ajoute le navigateur de fichiers aux shells locaux, basé sur le système de fichiers local.` |

| msgid | ja-JP | pt-BR |
|---|---|---|
| `Files` | `ファイル` | `Arquivos` |
| `Files — hover to open` | `ファイル — カーソルを合わせて開く` | `Arquivos — passe o cursor para abrir` |
| `Show the panel on local terminal tabs` | `ローカルターミナルのタブでもパネルを表示` | `Mostrar o painel nas abas de terminal local` |
| `Adds the file browser to local shells, backed by the local filesystem.` | `ローカルファイルシステムを使ったファイルブラウザーをローカルシェルに追加します。` | `Adiciona o navegador de arquivos às shells locais, usando o sistema de arquivos local.` |

- [ ] **Step 2: Verify the catalogs**

Run: `npm test`
Expected: PASS, 53 tests. `i18n.test.ts` now compares 119 msgids per catalog (115 + 4) and confirms all seven sets are identical with no empty msgstr. If it fails, a catalog is missing an entry or has an empty translation.

- [ ] **Step 3: Update AGENTS.md**

Per the file's own standing instruction, the module map and the internals notes must land with the change. Edit these sections:

- **Layout** — add three entries in the `src/` tree, in the style of the surrounding lines:
  - `local-path.ts` — virtual posix ↔ native path conversion (`/C:/Users/x` ↔ `C:\Users\x`), drive-root enumeration; pure, `window`-free so `node:test` can import it
  - `local-fs.session.ts` — `LocalFsSession`, duck-types `SFTPSession` over node `fs` so the panel browses a local tab with no call-site changes; streams `upload`/`download` through the same transfer interface
  - `local-ops.ts` — the three ops a local tab does differently: `fs.cp` copy, rename-with-EXDEV-fallback move, recycle-bin delete via Electron `shell.trashItem`
- **Layout** — update the `mount.service.ts` and `config.ts` lines: mounting now covers local terminal tabs (`profile.type === 'local'`, gated on `localTabs`), and `config.ts` gained `localTabs`.
- **Layout** — update the `*.test.ts` line: 53 units (sftp-util 30 + logic 4 + i18n 2 + local-path 7 + local-fs.session 6 + local-ops 4).
- **Build / test / verify** — update the `npm test` line to 53 units with the same breakdown.
- **i18n** — the catalogs now carry 119 msgids each, not 115.
- **Tabby internals that bite** — add an entry, since this is exactly the class of fact that section exists for:

  > - **Local tabs and path flavour.** The panel imports `posix as path`, and `posix.resolve('C:/a/b', '..')` does not recognise `C:/` as a root — it prepends `process.cwd()` and returns garbage. So `LocalFsSession` presents *virtual* posix paths (`/C:/Users/x`) and converts to native only at the fs boundary; `/` is a synthetic root whose listing is the drive list (probe `A:\`…`Z:\` with `existsSync` — no `wmic`). A local pane is detected by `tab.profile?.type === 'local'` and handed a **stable** wrapper object (cached per pane in a `WeakMap`): `setSession()` treats a different object as a reconnect and drops the open handle, so a fresh wrapper per focus change would reopen the listing every time. Local sessions have no `shell` field, so `openIfReady`'s shell-channel wait must be skipped or it burns its full 5s cap before the panel works. Everything reached through `exec()` (home resolve, `ls -l` owners, root detect, chown) degrades on its own — `exec()` returns `null` without an `ssh` object.
- **Status** — add a bullet: the panel also runs on local terminal tabs as a plain file explorer (`localTabs`, on by default), backed by the local filesystem; upload/download affordances and the owner/group columns are hidden there, chmod is posix-only, delete goes to the recycle bin, and "edit locally" becomes a direct editor spawn with no temp copy.

- [ ] **Step 4: Update README.md**

Add the local-tab explorer to the feature list, in the existing voice and formatting. One or two sentences: the panel also appears on local terminal tabs and browses the local filesystem (starting in the shell's working directory), with remote-only actions hidden and deletes going to the recycle bin; it can be turned off with the "Show the panel on local terminal tabs" setting.

- [ ] **Step 5: Verify**

Run: `npm test`
Expected: PASS, 53 tests.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npm run build`
Expected: emits `dist/index.js` without errors.

**Manual check in a running Tabby:** switch Tabby to German, open a local tab, confirm the strip reads "Dateien" and the settings toggle is translated. This also exercises the merge-after-render refresh path in `i18n.service.ts`.

- [ ] **Step 6: Commit**

```bash
git add locale AGENTS.md README.md
git commit -m "docs: document local-tab browsing and translate its new strings"
```

---

## Deferred, on purpose

Recorded here so the next reader does not mistake these for oversights. All four are in the spec's out-of-scope list or arise from a decision made in it.

- **Live CWD following.** The working directory is read once, at open. Tabby emits no CWD event, so following would need polling plus a follow/unfollow toggle to stop it fighting manual navigation.
- **The EXDEV fallback in `localMove` is untested.** Provoking it needs two volumes, which a unit test cannot assume. The code path is three lines and reuses `localCopy`, which *is* tested.
- **`LocalFsSession.open()` ignores the russh `OPEN_*` flags** and always opens `'wx'`. Its only caller creates an empty file. Revisit if a second caller appears.
- **Owner and group on posix local tabs.** `fs.Stats` carries `uid`/`gid`, but only the current user's name is resolvable without a passwd lookup, so the columns stay hidden on all local tabs rather than on Windows only.
- **UNC paths (`\\server\share`) are not supported.** The virtual scheme is drive-letter shaped: `toVirtualPath('\\\\server\\share')` yields `/server/share`, which `toNativePath` maps back to the *relative* `server\share`. Browsing a network location therefore needs a mapped drive letter. Supporting UNC properly means a distinguishable prefix in the virtual scheme and is worth doing only if someone asks.
