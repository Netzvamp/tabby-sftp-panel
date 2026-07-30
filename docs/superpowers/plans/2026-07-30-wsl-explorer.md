# WSL-tab Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a WSL terminal tab, the panel browses that distribution's filesystem as ordinary posix paths instead of showing the Windows filesystem.

**Architecture:** A WSL tab is already a local tab (`profile.type === 'local'`) running `wsl.exe`. `LocalFsSession` and `local-ops` gain a **base** — `\\wsl$\<distro>` — prepended only at the `fs` boundary, so virtual paths become real posix paths inside the distribution and the panel needs no display mapping. Detection and registry lookup live in a new `src/wsl.ts`.

**Tech Stack:** TypeScript, Angular 15 (JIT, via Tabby's DI), webpack UMD, `node:test` via `tsx`, gettext `.po` catalogs.

## Global Constraints

Copied from `docs/superpowers/specs/2026-07-30-wsl-explorer-design.md` and `AGENTS.md`. Every task's requirements implicitly include this section.

- **Run `npm run build` after every code change.** Tabby loads `dist/index.js`, not the source.
- **`npx tsc --noEmit -p tsconfig.json` is required** — the build uses `transpileOnly` and does not type-check.
- **Node builtins and runtime classes go through `(window as any).require`**, never a bare `import`. A bare import from a junctioned plugin resolves to the plugin's own `node_modules` copy.
- **A msgid must never contain an apostrophe** — it is a MessageFormat escape character and mangles the English fallback. Reword the source string instead.
- **All seven `locale/*.po` files must carry identical msgid sets with no empty msgstr** — `src/i18n.test.ts` enforces this and will fail otherwise.
- **Do not re-translate strings Tabby already ships** (Copy, Download, Delete, Cancel, Name, Group, Left, Right, Clear, Create directory, File transfers, Edit locally, Skip, Overwrite).
- `_tabby-ref/` is READ-ONLY reference (~14k files) — scope every glob to `src/**` or `docs/**`.
- **Never run `npm publish` by hand.** CI owns publishing.
- Work happens on branch `wsl-explorer`.
- Base value is always `\\wsl$\<distro>` — for WSL1 too. Never the WSL1 `BasePath\rootfs` form.
- `sftpPanel.wslTabs` defaults to `true`. Its settings row renders **only on win32**.

## Measured 9p facts these tasks depend on

Verified on the target machine; do not re-derive, and do not "fix" code that accounts for them.

| Fact | Consequence |
|---|---|
| `stat().mode` is always `100666` / `40666`; `chmod` succeeds and changes nothing | Permissions column and chmod stay hidden on win32 — no code change |
| `lstat` / `stat` / `readlink` / `readdir` **all fail** on a symlink (`ENOENT` or `EISDIR`) | Symlinks are listed from dirent flags and cannot be opened |
| `readdir(…, {withFileTypes: true})` flags symlinks correctly | The only reliable symlink signal |
| `stat().dev` is always `0`; `ino` is real | dev+ino identity holds within one filesystem only |
| `\\wsl$` (share root) is not enumerable | The distro name must come from the profile args or the registry |
| `path.win32.resolve('\\\\wsl$\\Ubuntu', '..')` → `\\wsl$\Ubuntu\` | The base cannot be escaped upward |
| `reg.exe` messages are localized, its data lines are not | Parse by structure, never by English words |

---

### Task 1: `toNativeFsPath` learns a base

**Files:**
- Modify: `src/local-path.ts:24-30`
- Test: `src/local-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toNativeFsPath(virtual: string, base = '', win = isWin): string`. **The signature changes** — `base` is inserted as the second parameter, so every existing call that passed `win` positionally must be updated. Tasks 3 and 4 rely on this shape.

- [ ] **Step 1: Write the failing tests**

Add to `src/local-path.test.ts`:

```ts
test('toNativeFsPath prepends a base and converts separators', () => {
    assert.equal(toNativeFsPath('/home/x', '\\\\wsl$\\Ubuntu', true), '\\\\wsl$\\Ubuntu\\home\\x')
    assert.equal(toNativeFsPath('/home/x/a b.txt', '\\\\wsl$\\Ubuntu', true), '\\\\wsl$\\Ubuntu\\home\\x\\a b.txt')
    // The distro root maps to the base itself — readdir on it works (verified against 9p).
    assert.equal(toNativeFsPath('/', '\\\\wsl$\\Ubuntu', true), '\\\\wsl$\\Ubuntu')
    // A based session on posix keeps posix separators, which is what makes the tests
    // covering Tasks 3 and 4 runnable on the Linux CI runner.
    assert.equal(toNativeFsPath('/home/x', '/tmp/base', false), '/tmp/base/home/x')
    assert.equal(toNativeFsPath('/', '/tmp/base', false), '/tmp/base')
})

test('toNativeFsPath with a base refuses a path that is not absolute', () => {
    // A based session has no drives and no relative paths: everything the panel holds is an
    // absolute posix path. Anything else would concatenate into a path inside the base that
    // the caller never meant.
    assert.throws(() => toNativeFsPath('home/x', '\\\\wsl$\\Ubuntu', true), /not an absolute path/)
    assert.throws(() => toNativeFsPath('C:\\x', '\\\\wsl$\\Ubuntu', true), /not an absolute path/)
})

test('toNativeFsPath with a base cannot be escaped upward', () => {
    // Pinned as a property, not an implementation detail: win32.resolve stops at the share
    // root, so a stray '..' can only ever land back on the base.
    const nodePath = require('node:path')
    assert.equal(
        nodePath.win32.resolve(toNativeFsPath('/..', '\\\\wsl$\\Ubuntu', true)),
        '\\\\wsl$\\Ubuntu\\')
})
```

Update the existing calls in the same file, which passed `win` in the position `base` now occupies — `src/local-path.test.ts:54-64`:

```ts
test('toNativeFsPath refuses win32 paths that are not rooted at a drive', () => {
    assert.throws(() => toNativeFsPath('/foo', '', true), /not a path on any drive/)
    assert.throws(() => toNativeFsPath('/', '', true), /not a path on any drive/)
    assert.throws(() => toNativeFsPath(toVirtualPath('\\\\server\\share\\x', true), '', true))
    // Drive-rooted paths pass through exactly like toNativePath.
    assert.equal(toNativeFsPath('/C:/Users/x', '', true), 'C:\\Users\\x')
    assert.equal(toNativeFsPath('/C:', '', true), 'C:\\')
    // On posix every absolute path is rooted, and the guard never fires.
    assert.equal(toNativeFsPath('/home/x', '', false), '/home/x')
    assert.equal(toNativeFsPath('/', '', false), '/')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/local-path.test.ts`
Expected: FAIL — the base tests get `'\\\\wsl$\\Ubuntu'` treated as a truthy `win` argument and produce wrong output or throw the drive-root error.

- [ ] **Step 3: Implement**

Replace `src/local-path.ts:19-30` with:

```ts
/** `toNativePath` for anything about to be handed to `fs`. On win32 a virtual path that is
 *  not rooted at a drive (`/foo`, or a UNC path flattened by toVirtualPath) would come back
 *  RELATIVE — every `fs` call then resolves it against Tabby's own working directory and
 *  writes into the install folder. There is no correct native path to fall back on, so refuse
 *  loudly instead. Every fs boundary (LocalFsSession, local-ops) goes through this.
 *
 *  `base` makes the session rooted somewhere else entirely: a WSL distro share
 *  (`\\wsl$\Ubuntu`). There the virtual paths ARE the distribution's own posix paths, so the
 *  drive rule does not apply — the base carries the only native prefix there is, and the only
 *  requirement is that the path be absolute. `win32.resolve` stops at the share root, so a
 *  stray `..` cannot escape the base. */
export function toNativeFsPath (virtual: string, base = '', win = isWin): string {
    if (base) {
        if (!virtual.startsWith('/')) { throw new Error(`${virtual} is not an absolute path`) }
        const sep = win ? '\\' : '/'
        const rel = virtual.replace(/^\/+/, '').replace(/\//g, sep)
        return rel ? base + sep + rel : base
    }
    const native = toNativePath(virtual, win)
    if (win && !/^[A-Za-z]:[\\/]/.test(native)) {
        throw new Error(`${virtual} is not a path on any drive`)
    }
    return native
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/local-path.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Fix the other callers and type-check**

`src/local-fs.session.ts` and `src/local-ops.ts` call `toNativeFsPath(p)` with one argument only, so they still compile unchanged. Confirm:

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run build`
Expected: no type errors, all tests pass, build emits `dist/index.js`.

- [ ] **Step 6: Commit**

```bash
git add src/local-path.ts src/local-path.test.ts
git commit -m "feat: let toNativeFsPath root a session at a base path

A WSL tab browses \\\\wsl\$\\<distro>, where the panel's virtual paths are the
distribution's own posix paths and the drive-root rule does not apply. The base
carries the native prefix; the only requirement left is that the path be
absolute, since win32.resolve already stops at the share root."
```

---

### Task 2: `src/wsl.ts` — detection and registry lookup

**Files:**
- Create: `src/wsl.ts`
- Test: `src/wsl.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `wslDistroOf(command: string, args: string[]): string | null` — `null` = not a WSL profile, `''` = the default distro, otherwise the distro name.
  - `parseLxss(out: string): { defaultDistro: string | null, uids: Record<string, number> }`
  - `homeFromPasswd(passwd: string, uid: number): string | null`
  - `wslBase(distro: string): string` — `\\wsl$\<distro>`
  - `wslBaseFor(profile: any): Promise<{ base: string, uid: number } | null>` — `null` when the profile is not WSL or the distro cannot be determined. Task 5 calls this.
  - `wslHome(base: string, uid: number): Promise<string>` — always returns an absolute posix path. Task 6 calls this.

- [ ] **Step 1: Write the failing tests**

Create `src/wsl.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// wsl.ts reaches child_process and fs through Electron's `window.require` — shim it before
// importing, exactly as local-ops.test.ts does.
;(globalThis as any).window = { require: createRequire(import.meta.url) }
const { wslDistroOf, parseLxss, homeFromPasswd, wslBase, wslHome } = await import('./wsl')

// Captured verbatim from `reg.exe query HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss /s`
// on a real machine. Note the trailing empty value and the path value containing backslashes.
const REG_OUT = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss
    DefaultVersion    REG_DWORD    0x2
    NatIpAddress    REG_SZ    172.24.182.15
    DefaultDistribution    REG_SZ    {7698004f-ac64-4173-8f91-f20feab1795e}
    OOBEComplete    REG_DWORD    0x1

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{035ac4ae-ebc1-4160-a1c7-2a92f65a1970}
    State    REG_DWORD    0x1
    DistributionName    REG_SZ    Debian
    BasePath    REG_SZ    C:\\Users\\N\\AppData\\Local\\Packages\\TheDebianProject\\LocalState
    DefaultUid    REG_DWORD    0x3e8

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{7698004f-ac64-4173-8f91-f20feab1795e}
    State    REG_DWORD    0x1
    DistributionName    REG_SZ    Ubuntu
    BasePath    REG_SZ    \\\\?\\F:\\WSL\\Ubuntu
    DefaultUid    REG_DWORD    0x0
    ShortcutPath    REG_SZ
`

test('wslDistroOf recognises wsl.exe and reads the -d argument', () => {
    assert.equal(wslDistroOf('C:\\Windows\\system32\\wsl.exe', ['-d', 'Ubuntu']), 'Ubuntu')
    assert.equal(wslDistroOf('C:\\Windows\\system32\\wsl.exe', ['--distribution', 'kali-linux']), 'kali-linux')
    // No -d: the default distro, which only the registry can name.
    assert.equal(wslDistroOf('C:\\Windows\\system32\\wsl.exe', []), '')
    // The legacy "Bash on Windows" shell is a WSL profile too.
    assert.equal(wslDistroOf('C:\\Windows\\system32\\bash.exe', []), '')
    // Case and separators must not matter — a user-edited profile can spell it either way.
    assert.equal(wslDistroOf('C:/Windows/System32/WSL.EXE', ['-d', 'Debian']), 'Debian')
})

test('wslDistroOf returns null for anything that is not WSL', () => {
    assert.equal(wslDistroOf('C:\\Windows\\system32\\cmd.exe', []), null)
    assert.equal(wslDistroOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe', ['-NoLogo']), null)
    assert.equal(wslDistroOf('/bin/bash', []), null)   // posix bash is not WSL
    assert.equal(wslDistroOf('', []), null)
})

test('wslDistroOf ignores a trailing -d with no value', () => {
    // Guards the loop bound: reading args[i + 1] past the end would yield undefined and
    // produce a base of '\\\\wsl$\\undefined'.
    assert.equal(wslDistroOf('wsl.exe', ['-d']), '')
})

test('parseLxss maps the default distro and every DefaultUid', () => {
    const info = parseLxss(REG_OUT)
    assert.equal(info.defaultDistro, 'Ubuntu')
    // 0x3e8 = 1000. The hex form is what reg.exe prints for REG_DWORD.
    assert.equal(info.uids.Debian, 1000)
    // 0x0 must survive as 0 and not be lost to a falsy check — root is a legitimate default.
    assert.equal(info.uids.Ubuntu, 0)
})

test('parseLxss survives a missing or unreadable key', () => {
    assert.deepEqual(parseLxss(''), { defaultDistro: null, uids: {} })
    assert.deepEqual(parseLxss('ERROR: The system was unable to find the specified registry key'),
        { defaultDistro: null, uids: {} })
})

test('homeFromPasswd finds the home directory for a uid', () => {
    const passwd = [
        'root:x:0:0:root:/root:/bin/bash',
        'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
        'rlieback:x:1000:1000:,,,:/home/rlieback:/bin/bash',
        '',
    ].join('\n')
    assert.equal(homeFromPasswd(passwd, 1000), '/home/rlieback')
    assert.equal(homeFromPasswd(passwd, 0), '/root')
    assert.equal(homeFromPasswd(passwd, 4242), null)
    // A uid that appears in the GID field must not match.
    assert.equal(homeFromPasswd('x:x:5:1000:,,,:/home/wrong:/bin/sh', 1000), null)
})

test('wslBase builds the share path for a distro', () => {
    assert.equal(wslBase('Ubuntu'), '\\\\wsl$\\Ubuntu')
    assert.equal(wslBase('kali-linux'), '\\\\wsl$\\kali-linux')
})

test('wslHome reads passwd under the base and falls back downward', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sftp-panel-wsl-'))
    try {
        mkdirSync(join(dir, 'etc'))
        writeFileSync(join(dir, 'etc', 'passwd'),
            'root:x:0:0:root:/root:/bin/bash\nbob:x:1000:1000::/home/bob:/bin/bash\n')
        assert.equal(await wslHome(dir, 1000), '/home/bob')
        // Unknown uid falls back to root's home, which every distro has.
        assert.equal(await wslHome(dir, 4242), '/root')
        // No passwd at all still yields a usable absolute path.
        rmSync(join(dir, 'etc', 'passwd'))
        assert.equal(await wslHome(dir, 1000), '/')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/wsl.test.ts`
Expected: FAIL — `Cannot find module './wsl'`.

- [ ] **Step 3: Implement**

Create `src/wsl.ts`:

```ts
// A WSL tab in Tabby is an ordinary LOCAL tab (profile.type === 'local') that happens to run
// wsl.exe, so the panel already mounts on it — and, before this module existed, showed the
// Windows filesystem while the shell beside it sat in /home. Here we work out which
// distribution a tab is running and where its filesystem is reachable from Windows.
//
// Why not tabby-local's own Shell.fsBase: it exists (_tabby-ref/tabby-local/src/api.ts:16) but
// optionsFromShell (_tabby-ref/tabby-local/src/profiles.ts:79) never copies it into the
// profile, and the default-distro shell does not set it at all
// (_tabby-ref/tabby-electron/src/shells/wsl.ts:62). Nothing reaches us through the profile.

const req = (window as any).require

const WSL_EXES = ['wsl.exe', 'bash.exe']

/** Which distribution a local profile browses:
 *   - `null` — not a WSL profile at all
 *   - `''`   — WSL, but the DEFAULT distro, whose name only the registry knows
 *   - a name — taken from `-d` / `--distribution`
 *  Pure: the caller supplies `profile.options.command` and `.args`. */
export function wslDistroOf (command: string, args: string[]): string | null {
    const exe = (command || '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
    if (!WSL_EXES.includes(exe)) { return null }
    // `length - 1`: a trailing '-d' with no value must not read undefined off the end and
    // build a base of '\\wsl$\undefined'.
    for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '-d' || args[i] === '--distribution') { return args[i + 1] }
    }
    return ''
}

export interface LxssInfo {
    defaultDistro: string | null
    uids: Record<string, number>
}

/** Parse `reg.exe query <Lxss key> /s` output. Structure only, never English words:
 *  reg.exe localizes its MESSAGES (a missing key prints "FEHLER:" on a German Windows) but
 *  not its data lines. Value lines are `<4 spaces><name><4 spaces><type><4 spaces><value>`,
 *  and the value may be empty or contain spaces and backslashes. */
export function parseLxss (out: string): LxssInfo {
    const blocks: Record<string, Record<string, string>> = {}
    let current: Record<string, string> | null = null
    for (const raw of out.split(/\r?\n/)) {
        const key = /^HKEY_[^\s]*\\Lxss(\\.*)?$/.exec(raw.trim())
        if (key) {
            current = blocks[raw.trim()] = {}
            continue
        }
        const value = /^\s{4}(\S+)\s{4}(REG_\w+)\s{4}(.*)$/.exec(raw)
        if (value && current) { current[value[1]] = value[3].trim() }
    }
    const entries = Object.entries(blocks)
    const root = entries.find(([k]) => k.endsWith('\\Lxss'))
    const defaultGuid = root?.[1].DefaultDistribution ?? null
    const uids: Record<string, number> = {}
    let defaultDistro: string | null = null
    for (const [k, v] of entries) {
        const name = v.DistributionName
        if (!name) { continue }
        // REG_DWORD prints as hex ('0x3e8'). parseInt handles the 0x prefix at radix 16.
        // Missing DefaultUid means the distro was never configured — 1000 is the WSL default.
        uids[name] = v.DefaultUid === undefined ? 1000 : parseInt(v.DefaultUid, 16)
        if (defaultGuid && k.endsWith('\\' + defaultGuid)) { defaultDistro = name }
    }
    return { defaultDistro, uids }
}

/** The home directory of `uid` from an /etc/passwd body, or null.
 *  Fields: name:passwd:uid:gid:gecos:home:shell — the uid is field 3, the home field 6. */
export function homeFromPasswd (passwd: string, uid: number): string | null {
    for (const line of passwd.split(/\r?\n/)) {
        const f = line.split(':')
        if (f.length >= 6 && f[2] === String(uid) && f[5]) { return f[5] }
    }
    return null
}

/** Every distro, WSL1 included, is reachable at this share. Tabby's own shell provider uses
 *  the WSL1 `BasePath\rootfs` form instead, but `\\wsl$` has served WSL1 since Windows 10
 *  1903, so one form covers both and we never touch BasePath. */
export function wslBase (distro: string): string {
    return `\\\\wsl$\\${distro}`
}

// The registry is read at most once per Tabby session: distros are installed and removed far
// less often than tabs are opened, and a failed read must not be retried on every tab.
let lxssCache: Promise<LxssInfo> | null = null

function readLxss (): Promise<LxssInfo> {
    lxssCache ??= new Promise<LxssInfo>(resolve => {
        try {
            const exe = `${process.env.windir ?? 'C:\\Windows'}\\System32\\reg.exe`
            req('child_process').execFile(
                exe,
                ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'],
                { windowsHide: true, timeout: 5000 },
                // reg.exe exits non-zero when the key is missing (no WSL installed). That is
                // not an error worth surfacing — parseLxss returns an empty map either way.
                (_err: any, stdout: string) => resolve(parseLxss(stdout ?? '')),
            )
        } catch {
            resolve({ defaultDistro: null, uids: {} })
        }
    })
    return lxssCache
}

/** The share and default uid for a local profile, or null when it is not a WSL profile — or
 *  is one whose distro cannot be named (no `-d` and no readable registry), in which case the
 *  tab keeps browsing the Windows filesystem exactly as it did before. */
export async function wslBaseFor (profile: any): Promise<{ base: string, uid: number } | null> {
    const named = wslDistroOf(profile?.options?.command ?? '', profile?.options?.args ?? [])
    if (named === null) { return null }
    const info = await readLxss()
    const distro = named || info.defaultDistro
    if (!distro) { return null }
    return { base: wslBase(distro), uid: info.uids[distro] ?? 1000 }
}

/** The distribution home for `uid`, as a posix path inside the distro. Falls back to root's
 *  home and finally to '/', so the panel always has somewhere to open. */
export async function wslHome (base: string, uid: number): Promise<string> {
    try {
        const sep = base.includes('\\') ? '\\' : '/'
        const txt: string = await req('fs').promises.readFile(base + sep + 'etc' + sep + 'passwd', 'utf8')
        return homeFromPasswd(txt, uid) ?? homeFromPasswd(txt, 0) ?? '/'
    } catch {
        return '/'
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/wsl.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Type-check and build**

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/wsl.ts src/wsl.test.ts
git commit -m "feat: detect WSL tabs and locate their distro share

A WSL tab is a local tab running wsl.exe; the distro comes from its -d argument
or, for the default-distro profile, from the Lxss registry key read once via
reg.exe. The parser goes by structure because reg.exe localizes its messages but
not its data lines, and tabby-local drops Shell.fsBase before it reaches a
profile, so nothing usable arrives that way."
```

---

### Task 3: `LocalFsSession` gains a base and survives 9p symlinks

**Files:**
- Modify: `src/local-fs.session.ts`
- Test: `src/local-fs.session.test.ts`

**Interfaces:**
- Consumes: `toNativeFsPath(virtual, base, win)` from Task 1.
- Produces: `new LocalFsSession(base = '')`. Task 5 constructs it with a base.

- [ ] **Step 1: Write the failing tests**

Add to `src/local-fs.session.test.ts` (the file already shims `window.require` and defines `withTempDir`):

```ts
test('a based session browses posix paths rooted at the base', async () => {
    await withTempDir(async (dir) => {
        mkdirSync(join(dir, 'home', 'bob'), { recursive: true })
        writeFileSync(join(dir, 'home', 'bob', 'a.txt'), 'hello')
        // The base stands in for '\\wsl$\Ubuntu'. Paths in and out are the distro's own.
        const s = new LocalFsSession(dir)
        const rootEntries = await s.readdir('/')
        assert.deepEqual(rootEntries.map((e: any) => e.name), ['home'])
        assert.equal(rootEntries[0].fullPath, '/home')
        const st = await s.stat('/home/bob/a.txt')
        assert.equal(st.size, 5)
        await s.mkdir('/home/bob/sub')
        assert.ok(existsSync(join(dir, 'home', 'bob', 'sub')))
    })
})

test('a based session does not list drives at the root', async () => {
    await withTempDir(async (dir) => {
        // Without a base, '/' on win32 is the synthetic drive-list root. With one it is a real
        // directory in the distribution, and returning drives there would be nonsense.
        const s = new LocalFsSession(dir)
        assert.deepEqual((await s.readdir('/')).map((e: any) => e.name), [])
    })
})

test('readdir keeps a symlink row when lstat fails on it', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'real.txt'), 'x')
        symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'))
        const s = new LocalFsSession()
        // WSL's 9p redirector throws ENOENT/EISDIR on lstat of a symlink while readdir's
        // dirent flags stay correct. Force that shape by making lstat fail for the link.
        const fsp = (globalThis as any).window.require('fs').promises
        const realLstat = fsp.lstat
        fsp.lstat = async (p: string) => {
            if (String(p).endsWith('link.txt')) { throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' }) }
            return realLstat(p)
        }
        try {
            const entries = (await s.readdir(vdir)).sort((a: any, b: any) => a.name.localeCompare(b.name))
            assert.deepEqual(entries.map((e: any) => e.name), ['link.txt', 'real.txt'])
            const link = entries[0]
            assert.equal(link.isSymlink, true, 'the dirent flag is the only reliable signal here')
            assert.equal(link.fullPath, vdir + '/link.txt')
            assert.ok((link.mode & 0o170000) === 0o120000, 'mode must carry the symlink type bits')
        } finally {
            fsp.lstat = realLstat
        }
    })
})

test('readdir still drops an entry that vanished between readdir and lstat', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'gone.txt'), 'x')
        writeFileSync(join(dir, 'stays.txt'), 'x')
        const s = new LocalFsSession()
        const fsp = (globalThis as any).window.require('fs').promises
        const realLstat = fsp.lstat
        // A plain file whose lstat fails is genuinely gone — the symlink fallback must not
        // turn it into a ghost row.
        fsp.lstat = async (p: string) => {
            if (String(p).endsWith('gone.txt')) { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
            return realLstat(p)
        }
        try {
            assert.deepEqual((await s.readdir(vdir)).map((e: any) => e.name), ['stays.txt'])
        } finally {
            fsp.lstat = realLstat
        }
    })
})
```

Extend the import at `src/local-fs.session.test.ts:3` so `mkdirSync` and `existsSync` are available:

```ts
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, symlinkSync } from 'node:fs'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/local-fs.session.test.ts`
Expected: FAIL — the constructor takes no argument, so the based paths resolve against the temp dir's own virtual path and the symlink row is dropped.

- [ ] **Step 3: Implement**

In `src/local-fs.session.ts`, add the constructor and a private path helper to the class, immediately above `readdir`:

```ts
export class LocalFsSession {
    /** `base` roots the whole session at a native prefix — a WSL distro share
     *  (`\\wsl$\Ubuntu`). With one set, the virtual paths this session speaks ARE the
     *  distribution's own posix paths: `/` is a real directory rather than the synthetic
     *  drive-list root, and there are no drives to enumerate. Empty = an ordinary local tab. */
    constructor (private base = '') {}

    private native (p: string): string {
        return toNativeFsPath(p, this.base)
    }
```

Replace every `toNativeFsPath(x)` call in the class body with `this.native(x)` — at lines 18, 26, 33, 45, 53, 54, 55, 56 (both arguments), 57, 64 and 84 of the current file. Guard the drive-list branch on the base and switch `readdir` to dirents:

```ts
    async readdir (p: string): Promise<SFTPFile[]> {
        if (!this.base && isVirtualRoot(p)) { return this.drives() }
        const ents: any[] = await fsp.readdir(this.native(p), { withFileTypes: true })
        const out = await Promise.all(ents.map(e => this.entry(p, e)))
        // Entries can vanish between readdir and lstat — drop them rather than fail the listing.
        return out.filter(Boolean) as SFTPFile[]
    }
```

Replace `entry()` (currently `src/local-fs.session.ts:105-115`):

```ts
    private async entry (dir: string, ent: any): Promise<SFTPFile | null> {
        const full = dir.replace(/\/+$/, '') + '/' + ent.name
        try {
            // lstat, not stat: SFTP readdir does not follow symlinks either, and following
            // them here would hang on a link into a dead network mount.
            const st = await fsp.lstat(this.native(full))
            return this.toFile(full, st, st.isSymbolicLink())
        } catch {
            // WSL's 9p redirector fails EVERY symlink call — lstat, stat, readlink and
            // readdir all throw ENOENT or EISDIR on one — while readdir's dirent flags stay
            // correct. Synthesise the row from the flag rather than hide /bin, /lib and /sbin
            // from the listing. Restricted to symlinks on purpose: any other lstat failure
            // still means the entry vanished between the two calls, and inventing a row for
            // that would be a ghost.
            if (!ent.isSymbolicLink?.()) { return null }
            return {
                name: ent.name,
                fullPath: full,
                isDirectory: false,
                isSymlink: true,
                mode: 0o120777,   // symlink type bits, so the icon and mode string are right
                size: 0,
                modified: new Date(0),
            }
        }
    }
```

Guard `drives()` for a based session is unnecessary — `readdir` no longer reaches it — but `stat`, `readlink` and the rest need no branch at all, since `this.native()` already carries the base.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/local-fs.session.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Type-check and build**

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/local-fs.session.ts src/local-fs.session.test.ts
git commit -m "feat: root LocalFsSession at a base and keep 9p symlink rows

With a base set the session speaks the distribution's own posix paths, so '/' is
a real directory instead of the drive-list root. WSL's 9p redirector throws on
every symlink call while readdir's dirent flags stay correct, so a failed lstat
on a dirent-flagged symlink now yields a row without metadata instead of
silently hiding /bin, /lib and /sbin."
```

---

### Task 4: `local-ops` gains a base and deletes permanently on it

**Files:**
- Modify: `src/local-ops.ts`
- Test: `src/local-ops.test.ts`

**Interfaces:**
- Consumes: `toNativeFsPath(virtual, base, win)` from Task 1.
- Produces, all with `base` appended so every existing call site and test keeps compiling unchanged:
  - `localExists(destDir: string, name: string, base = ''): Promise<boolean>`
  - `localRefusal(src: string, destDir: string, base = ''): Promise<string | null>`
  - `localCopy(src: string, destDir: string, overwrite = false, base = ''): Promise<string | null>`
  - `localMove(src: string, destDir: string, overwrite = false, base = ''): Promise<string | null>`
  - `localTrash(p: string, base = ''): Promise<string | null>`

  A non-empty `base` means a WSL share, and a WSL share has **no recycle bin**: removal is permanent. That coupling is deliberate — see the comment the implementation step puts on `clearDestination`.

- [ ] **Step 1: Write the failing tests**

Add to `src/local-ops.test.ts`:

```ts
test('a based copy resolves both endpoints under the base', async () => {
    await withTempDir(async (dir) => {
        mkdirSync(join(dir, 'home'), { recursive: true })
        mkdirSync(join(dir, 'srv'))
        writeFileSync(join(dir, 'home', 'a.txt'), 'hello')
        assert.equal(await localCopy('/home/a.txt', '/srv', false, dir), null)
        assert.equal(readFileSync(join(dir, 'srv', 'a.txt')).toString(), 'hello')
    })
})

test('a based localExists and localRefusal see the same tree', async () => {
    await withTempDir(async (dir) => {
        mkdirSync(join(dir, 'srv'))
        writeFileSync(join(dir, 'srv', 'a.txt'), 'x')
        writeFileSync(join(dir, 'a.txt'), 'y')
        assert.equal(await localExists('/srv', 'a.txt', dir), true)
        assert.equal(await localExists('/srv', 'nope.txt', dir), false)
        assert.equal(await localRefusal('/a.txt', '/srv', dir), null)
        // The overlap guard must work in base coordinates too: a directory into its own subtree.
        mkdirSync(join(dir, 'srv', 'inner'))
        assert.match(await localRefusal('/srv', '/srv/inner', dir) ?? '', /overlap/)
    })
})

test('a based delete is permanent and never touches the recycle bin', async () => {
    await withTempDir(async (dir) => {
        mkdirSync(join(dir, 'home'))
        writeFileSync(join(dir, 'home', 'a.txt'), 'x')
        const before = binned.length
        assert.equal(await localTrash('/home/a.txt', dir), null)
        assert.ok(!existsSync(join(dir, 'home', 'a.txt')), 'the file must be gone')
        assert.equal(binned.length, before, 'a WSL share has no recycle bin to route through')
    })
})

test('a based delete removes a whole tree', async () => {
    await withTempDir(async (dir) => {
        mkdirSync(join(dir, 'home', 'tree', 'sub'), { recursive: true })
        writeFileSync(join(dir, 'home', 'tree', 'sub', 'deep.txt'), 'x')
        assert.equal(await localTrash('/home/tree', dir), null)
        assert.ok(!existsSync(join(dir, 'home', 'tree')))
    })
})

test('a based overwrite deletes the destination permanently and says so on failure', async () => {
    await withTempDir(async (dir) => {
        mkdirSync(join(dir, 'srv'))
        writeFileSync(join(dir, 'a.txt'), 'new')
        writeFileSync(join(dir, 'srv', 'a.txt'), 'old')
        const before = binned.length
        assert.equal(await localCopy('/a.txt', '/srv', true, dir), null)
        assert.equal(readFileSync(join(dir, 'srv', 'a.txt')).toString(), 'new')
        assert.equal(binned.length, before, 'the bin must not be involved on a base')
    })
})

test('a based failure after clearing says the destination was deleted, not binned', async () => {
    await withTempDir(async (dir) => {
        mkdirSync(join(dir, 'srv'))
        writeFileSync(join(dir, 'srv', 'a.txt'), 'old')
        // Source vanishes after the destination is cleared: the copy then fails, and the user
        // must be told their destination is gone for good rather than sitting in a bin.
        writeFileSync(join(dir, 'a.txt'), 'new')
        const fsp = (globalThis as any).window.require('fs').promises
        const realCp = fsp.cp
        fsp.cp = async () => { throw new Error('EBUSY: resource busy or locked') }
        try {
            const err = await localCopy('/a.txt', '/srv', true, dir)
            assert.match(err ?? '', /deleted permanently/)
            assert.doesNotMatch(err ?? '', /recycle bin/)
        } finally {
            fsp.cp = realCp
        }
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/local-ops.test.ts`
Expected: FAIL — the functions take no `base`, so `/home/a.txt` is resolved as a bare virtual path and (on win32) refused, or (on posix CI) resolved outside the temp dir.

- [ ] **Step 3: Implement**

Thread `base` through `src/local-ops.ts`. Every helper that resolves or removes a path takes it.

```ts
/** A drive root has an empty basename, so `join(dest, basename('C:\\'))` collapses to the
 *  destination itself and a "copy C:" would recursively clone the whole system drive over it.
 *  The panel already keeps those rows out of its menus; this is the backstop.
 *  A based session has no drives at all — every path in it is a posix path in the
 *  distribution — so the check is inert there. */
function refuseDriveRoot (p: string, base: string): string | null {
    return !base && isDriveRoot(p) ? `${p} is a drive root — copy, move and delete are not available for it` : null
}
```

```ts
export async function localExists (destDir: string, name: string, base = ''): Promise<boolean> {
    try {
        return await statOf(nodePath.join(toNativeFsPath(destDir, base), name)) !== null
    } catch {
        return false
    }
}
```

```ts
async function endpoints (src: string, destDir: string, base: string): Promise<{ from: string, to: string } | string> {
    const refused = refuseDriveRoot(src, base)
    if (refused) { return refused }
    let from: string, to: string
    try {
        from = toNativeFsPath(src, base)
        to = nodePath.join(toNativeFsPath(destDir, base), nodePath.basename(from))
    } catch (e: any) {
        return e?.message ?? String(e)
    }
    // …the rest of the body is unchanged…
}

export async function localRefusal (src: string, destDir: string, base = ''): Promise<string | null> {
    const ends = await endpoints(src, destDir, base)
    return typeof ends === 'string' ? ends : null
}
```

Removal is where the base changes behaviour, not just coordinates:

```ts
/** "Overwrite" means REPLACE, for both files and directories and for both copy and move:
 *  fs.rename cannot replace a non-empty directory at all (EPERM/ENOTEMPTY) and fs.cp merges
 *  into one, so the destination goes first once the user has consented.
 *  Without a base, via the RECYCLE BIN, like `localTrash`: consenting to "Overwrite" is not
 *  consent to a permanent delete, and the panel never hard-deletes on an ordinary local tab.
 *  A failing bin is reported, never quietly downgraded to `fs.rm`.
 *  WITH a base it is permanent, because a WSL share has no recycle bin to route through —
 *  `shell.trashItem` on \\wsl$ fails, or worse deletes permanently anyway. The panel says so in
 *  the overwrite prompt BEFORE this runs, so the consent is still informed. A second base kind
 *  that does have a bin would need this coupling split into its own flag; today base implies WSL.
 *  Returns whether anything was actually removed: the window between the collision check and
 *  here contains a MODAL DIALOG — a user who resolves the conflict by deleting the destination
 *  in their file manager and then clicks Overwrite must get a successful copy, not ENOENT.
 *  Only ENOENT counts as "already gone": any other stat failure (EACCES on the parent, say) is
 *  reported, because treating it as cleared would silently downgrade the overwrite the user asked
 *  for into an fs.cp MERGE. */
async function clearDestination (to: string, base: string): Promise<boolean> {
    try {
        await fsp.stat(to)
    } catch (e: any) {
        if (e?.code === 'ENOENT') { return false }
        throw e
    }
    if (base) {
        await fsp.rm(to, { recursive: true, force: true })
    } else {
        await req('electron').shell.trashItem(to)
    }
    return true
}

/** The destination is removed BEFORE the copy/rename, so a failure there (EBUSY/EACCES on a
 *  locked file is routine on Windows, ENOSPC, a source that vanished) leaves it gone. Say so,
 *  and say WHICH — on an ordinary local tab the item is in the recycle bin and recoverable, on a
 *  WSL share it is not, and the user cannot tell from a raw errno. */
function afterClear (msg: string, cleared: boolean, base: string): string {
    if (!cleared) { return msg }
    return base
        ? `${msg}; the existing destination had already been deleted permanently`
        : `${msg}; the existing destination had already been moved to the recycle bin`
}

/** Remove the destination when the user consented, or the message to report. `{ cleared }` says
 *  whether anything actually went away, which is what the failure wording keys off. */
async function clear (to: string, overwrite: boolean, base: string): Promise<{ cleared: boolean } | string> {
    if (!overwrite) { return { cleared: false } }
    try {
        return { cleared: await clearDestination(to, base) }
    } catch (e: any) {
        return base
            ? `could not delete the existing destination: ${e?.message ?? String(e)}`
            : `could not move the existing destination to the recycle bin: ${e?.message ?? String(e)}`
    }
}
```

```ts
export async function localCopy (src: string, destDir: string, overwrite = false, base = ''): Promise<string | null> {
    const ends = await endpoints(src, destDir, base)
    if (typeof ends === 'string') { return ends }
    const cleared = await clear(ends.to, overwrite, base)
    if (typeof cleared === 'string') { return cleared }
    try {
        await fsp.cp(ends.from, ends.to, { recursive: true, errorOnExist: !overwrite, force: overwrite })
        return null
    } catch (e: any) {
        return afterClear(e?.message ?? String(e), cleared.cleared, base)
    }
}

export async function localMove (src: string, destDir: string, overwrite = false, base = ''): Promise<string | null> {
    const ends = await endpoints(src, destDir, base)
    if (typeof ends === 'string') { return ends }
    const cleared = await clear(ends.to, overwrite, base)
    if (typeof cleared === 'string') { return cleared }
    try {
        await fsp.rename(ends.from, ends.to)
        return null
    } catch (e: any) {
        if (e?.code !== 'EXDEV') { return afterClear(e?.message ?? String(e), cleared.cleared, base) }
        const copyErr = await localCopy(src, destDir, false, base)
        if (copyErr) {
            return afterClear(`cross-device move stopped partway through the copy; the destination may hold a partial copy: ${copyErr}`, cleared.cleared, base)
        }
        try {
            await fsp.rm(ends.from, { recursive: true, force: true })
            return null
        } catch (e2: any) {
            return `copied, but could not remove the source: ${e2?.message ?? String(e2)}`
        }
    }
}
```

```ts
/** Remove an item. Without a base, to the OS recycle bin: deleting a local file has no remote
 *  copy to fall back on, and the OS already owns undo. With a base it is permanent — a WSL
 *  share has no bin — which is why the panel's confirmation says so on those tabs.
 *  `electron` is required lazily so importing this module never needs it: the fs helpers stay
 *  unit-testable, and a test that does exercise a bin can stub `window.require('electron')`. */
export async function localTrash (p: string, base = ''): Promise<string | null> {
    const refused = refuseDriveRoot(p, base)
    if (refused) { return refused }
    try {
        const native = toNativeFsPath(p, base)
        if (base) {
            await fsp.rm(native, { recursive: true, force: true })
        } else {
            await req('electron').shell.trashItem(native)
        }
        return null
    } catch (e: any) {
        return e?.message ?? String(e)
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/local-ops.test.ts`
Expected: PASS, 32 tests.

- [ ] **Step 5: Type-check and build**

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/local-ops.ts src/local-ops.test.ts
git commit -m "feat: run local file operations against a base, deleting permanently there

Both endpoints, the collision check and the overlap guard resolve under the base
so a WSL share is browsed in its own coordinates. Removal is the one behaviour
that changes rather than just moving: \\\\wsl\$ has no recycle bin, so Delete and
Overwrite are permanent there, and the failure wording says deleted permanently
instead of promising a bin the user cannot open."
```

---

### Task 5: Mount wiring, config key and the win32-only setting

**Files:**
- Modify: `src/mount.service.ts:108-119`
- Modify: `src/config.ts:15`
- Modify: `src/settings.ts:59-65`

**Interfaces:**
- Consumes: `wslBaseFor(profile)` from Task 2, `new LocalFsSession(base)` from Task 3.
- Produces: the local session wrapper gains two fields the panel reads in Task 6 —
  `base: string` (`''` on an ordinary local tab) and `uid: number`. Both are set before
  `openSFTP()` resolves, which is the only point the panel can observe them from.

- [ ] **Step 1: Add the config key**

In `src/config.ts`, directly after the `localTabs` line:

```ts
            localTabs: true,          // also mount the panel on local terminal tabs (local filesystem)
            wslTabs: true,            // on a WSL tab, browse the distro filesystem instead of Windows
```

- [ ] **Step 2: Wire the base into the session wrapper**

In `src/mount.service.ts`, add the import beside the existing one at line 6:

```ts
import { LocalFsSession } from './local-fs.session'
import { wslBaseFor } from './wsl'
```

Replace `localWrapper()` (`src/mount.service.ts:108-119`):

```ts
    private localWrapper (pane: any): any {
        let w = this.localSessions.get(pane)
        if (!w) {
            w = {
                local: true,
                // A WSL tab is a local tab running wsl.exe. Resolving the share here rather
                // than in the panel keeps the lookup on the one code path that already knows
                // the pane, and `base`/`uid` are assigned before openSFTP() resolves — which
                // is the earliest moment the panel can observe them.
                base: '',
                uid: 1000,
                openSFTP: async () => {
                    const wsl = this.config.store?.sftpPanel?.wslTabs
                        ? await wslBaseFor(pane.profile)
                        : null
                    w.base = wsl?.base ?? ''
                    w.uid = wsl?.uid ?? 1000
                    return new LocalFsSession(w.base)
                },
                getCwd: () => pane.session?.getWorkingDirectory?.() ?? Promise.resolve(null),
            }
            this.localSessions.set(pane, w)
        }
        return w
    }
```

- [ ] **Step 3: Add the settings row, win32 only**

In `src/settings.ts`, insert after the `localTabs` form-line (which ends at line 65):

```html
    <div class="form-line" *ngIf="isWindows">
      <div class="header">
        <div class="title">{{ 'Browse the WSL filesystem on WSL tabs' | translate }}</div>
        <div class="description">{{ 'On a WSL tab the panel shows that distribution files instead of the Windows drives. Delete is permanent there, because a WSL share has no recycle bin.' | translate }}</div>
      </div>
      <toggle [(ngModel)]="config.store.sftpPanel.wslTabs" (ngModelChange)="config.save()"></toggle>
    </div>
```

The description avoids an apostrophe on purpose ("that distribution files", not "that distribution's files") — see Global Constraints.

Add the flag the row is gated on, to the component class at `src/settings.ts:85-86`:

```ts
export class SftpPanelSettingsTabComponent {
  // WSL exists only on Windows, so the option is meaningless anywhere else.
  readonly isWindows = process.platform === 'win32'

  constructor (public config: ConfigService, private localEdit: LocalEditService, private zone: NgZone) {}
```

- [ ] **Step 4: Type-check and build**

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run build`
Expected: clean, all tests still passing.

- [ ] **Step 5: Commit**

```bash
git add src/mount.service.ts src/config.ts src/settings.ts
git commit -m "feat: hand WSL panes their distro share, behind wslTabs

The mount service resolves the share when it opens the session, so base and uid
are set before the panel can observe them. The setting is on by default and its
row renders only on win32, where WSL exists at all."
```

---

### Task 6: Panel branches

**Files:**
- Modify: `src/panel.component.ts` — lines 511-557 (`openIfReady`), 589-600 (`resolveHome`), 982-995 (the local getters), 1030-1046 (editor spawn), 1226 (Copy path), 1272-1287 (`confirmLocalOverwrite`), 1289-1349 (`applyServerMove` / `applyServerCopy`), 1597-1598 (drag-in collision), 1784-1823 (`deleteSelected`)

**Interfaces:**
- Consumes: `wslHome(base, uid)` from Task 2; `session.base` / `session.uid` from Task 5; the `base`-taking `local-ops` signatures from Task 4.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the base getter and make displayPath base-aware**

Add the import beside the existing local-path import at `src/panel.component.ts:20`:

```ts
import { wslHome } from './wsl'
```

Replace `src/panel.component.ts:984-995`:

```ts
    /** The native prefix this local session is rooted at — a WSL distro share
     *  (`\\wsl$\Ubuntu`) — or '' for an ordinary local tab browsing the Windows drives.
     *  Set by the mount service before openSFTP() resolves. */
    get localBase (): string { return (this.session as any)?.base ?? '' }

    /** The synthetic win32 root, whose listing is the drive list. It is not a directory: it
     *  can be listed and navigated, and nothing else — creating an entry "in" it would
     *  resolve relative to Tabby's own working directory. A based session has no such root:
     *  its '/' is a real directory inside the distribution. */
    atVirtualRoot (): boolean { return this.isLocal && !this.localBase && isVirtualRoot(this.path) }

    /** A drive-root row ('/C:'). Navigable only: its basename is empty, so copy/move/delete
     *  would act on the entire drive (verified: win32 basename('C:\\') === ''). A based
     *  session has no drives. */
    private isDriveRow (item: SFTPFile): boolean { return this.isLocal && !this.localBase && isDriveRoot(item.fullPath) }

    /** Paths shown to the user: a virtual path is meaningless outside this panel, so local
     *  tabs get the native one (same rule as "Copy path"). A BASED session is the exception —
     *  its virtual paths already are the distribution's own posix paths, which is exactly what
     *  the user wants to see and to paste into the shell beside the panel. The native form
     *  there is a \\wsl$ UNC path that means nothing inside the distro. */
    private displayPath (p: string): string { return this.isLocal && !this.localBase ? toNativePath(p) : p }
```

- [ ] **Step 2: Route the editor spawn through the base**

At `src/panel.component.ts:1030-1046` two call sites hand a native path to an external editor. A Windows editor needs the UNC form, so these use `toNativeFsPath` with the base rather than `displayPath`. Replace `toNativePath(item.fullPath)` in both with `toNativeFsPath(item.fullPath, this.localBase)`, and extend the import at line 20:

```ts
import { toVirtualPath, toNativePath, toNativeFsPath, isVirtualRoot, isDriveRoot, isWin } from './local-path'
```

- [ ] **Step 3: Make Copy path use displayPath**

Replace `src/panel.component.ts:1226`:

```ts
        const paths = targets.map(i => this.displayPath(i.fullPath))
```

`displayPath` is already the identity on remote tabs, so this covers all three flavours in one expression.

- [ ] **Step 4: Pass the base to every local-ops call**

Six call sites, all inside `applyServerMove` and `applyServerCopy`:

```ts
                if (!await localRefusal(t.fullPath, dest, this.localBase) && await localExists(dest, name, this.localBase)) {
```
```ts
                const err = await localMove(t.fullPath, dest, overwrite, this.localBase)
```
```ts
                const err = await localCopy(t.fullPath, dest, overwrite, this.localBase)
```

and in `deleteSelected`:

```ts
                    const err = await localTrash(item.fullPath, this.localBase)
```

- [ ] **Step 5: Say that delete and overwrite are permanent on a WSL tab**

In `deleteSelected` (`src/panel.component.ts:1789-1793`), pick the message by base:

```ts
        // Shift+Delete bypasses the confirmation dialog.
        if (!skipConfirm) {
            const ok = await this.platform.showMessageBox({
                type: 'warning',
                // A WSL share has no recycle bin, so this really is gone. Say it before, not
                // after — an ordinary local tab still routes through the bin and must not
                // frighten the user with wording that does not apply to it.
                message: this.localBase
                    ? this.translate.instant('Delete {n} item(s) permanently? A WSL share has no recycle bin.', { n: items.length })
                    : this.translate.instant('Delete {n} item(s)?', { n: items.length }),
                buttons: [this.translate.instant('Delete'), this.translate.instant('Cancel')], defaultId: 1, cancelId: 1,
            })
```

In `confirmLocalOverwrite` (`src/panel.component.ts:1274-1279`):

```ts
        const res = await this.platform.showMessageBox({
            type: 'warning',
            // Native path, except on a based session where the virtual path IS the real one.
            message: this.localBase
                ? this.translate.instant('{target} already exists. Overwriting deletes it permanently.', { target: this.displayPath(targetPath) })
                : this.translate.instant('{target} already exists.', { target: this.displayPath(targetPath) }),
            buttons: keys.map(k => this.translate.instant(k)), defaultId: keys.indexOf('Cancel'), cancelId: keys.indexOf('Cancel'),
        })
```

Update the comment block above `confirmLocalOverwrite` (`src/panel.component.ts:1268-1271`), whose last sentence is now only half true:

```ts
    // "Overwrite" means REPLACE, for files and directories alike: local-ops removes the
    // destination entry before the copy/move rather than merging into it (fs.cp merges and
    // fs.rename cannot replace a non-empty directory at all). On an ordinary local tab that
    // removal goes to the RECYCLE BIN, so consenting here is not consent to a permanent
    // delete. On a WSL share there is no bin and it is permanent — which is why the message
    // below says so before the user consents rather than after.
```

At `src/panel.component.ts:1597-1598` the drag-in collision prompt reuses the same msgid; make it match:

```ts
                message: this.isLocal
                    ? (this.localBase
                        ? this.translate.instant('{target} already exists. Overwriting deletes it permanently.', { target })
                        : this.translate.instant('{target} already exists.', { target: toNativePath(target) }))
```

- [ ] **Step 6: Resolve the start directory from the distribution**

Replace `resolveHome` (`src/panel.component.ts:589-600`):

```ts
    private async resolveHome (): Promise<string | null> {
        if (this.isLocal) {
            if (this.localBase) {
                // The terminal cwd is useless here: wsl.exe is a WINDOWS process whose cwd is
                // a Windows path, not a path inside the distribution. Resolve the distro home
                // from its own /etc/passwd instead, keyed by the uid WSL was configured with.
                return wslHome(this.localBase, (this.session as any)?.uid ?? 1000)
            }
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

Replace the start-directory fallback in `openIfReady` (`src/panel.component.ts:550-551`):

```ts
            // Folder gone after a reconnect (or start dir invalid) → fall back. On a based
            // session the configured startDirectory is very often a Windows path that cannot
            // exist in the distribution, so fall back to the distro home before '/', which is
            // a far less useful place to land than it is on a drive.
            if (!this.fileList && this.localBase) {
                const home = await this.resolveHome()
                if (home) { await this.navigate(home) }
            }
            if (!this.fileList) { await this.navigate('/') }
```

- [ ] **Step 7: Type-check and build**

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run build`
Expected: clean. `npm test` count is unchanged from Task 4 — this task adds no units, because every branch here is either template scope or needs a live Tabby (see the build-gate blind spot in AGENTS.md).

- [ ] **Step 8: Commit**

```bash
git add src/panel.component.ts
git commit -m "feat: browse, delete and address a WSL tab in distro coordinates

displayPath, the drive-row and virtual-root guards and every local-ops call now
key off the session base, so a WSL tab shows and pastes its own posix paths while
the editor still gets the \\\\wsl\$ UNC path it needs. Home comes from the distro
/etc/passwd rather than the terminal cwd, which on WSL is a Windows path, and the
delete and overwrite prompts say the removal is permanent where it is."
```

---

### Task 7: Catalogs and documentation

**Files:**
- Modify: `locale/de-DE.po`, `locale/es-ES.po`, `locale/fr-FR.po`, `locale/ja-JP.po`, `locale/pt-BR.po`, `locale/ru-RU.po`, `locale/zh-CN.po`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Test: `src/i18n.test.ts` (existing, must pass unchanged)

**Interfaces:**
- Consumes: the msgids introduced in Tasks 5 and 6.
- Produces: nothing.

- [ ] **Step 1: Collect the exact new msgids**

Four strings were added, all of which Tabby does not ship:

1. `Browse the WSL filesystem on WSL tabs` (Task 5)
2. `On a WSL tab the panel shows that distribution files instead of the Windows drives. Delete is permanent there, because a WSL share has no recycle bin.` (Task 5)
3. `Delete {n} item(s) permanently? A WSL share has no recycle bin.` (Task 6)
4. `{target} already exists. Overwriting deletes it permanently.` (Task 6)

Verify none contains an apostrophe — an apostrophe is a MessageFormat escape character and mangles the English fallback. Read the four strings above: none has one, and the settings description is deliberately worded "that distribution files" to keep it that way. If a later edit reintroduces one, reword the source string rather than escaping it.

- [ ] **Step 2: Add all four to every catalog**

Append to each of the seven `locale/*.po` files, translating msgstr per language and keeping `{n}` and `{target}` verbatim. German, as the reference:

```po
msgid "Browse the WSL filesystem on WSL tabs"
msgstr "Auf WSL-Tabs das WSL-Dateisystem anzeigen"

msgid "On a WSL tab the panel shows that distribution files instead of the Windows drives. Delete is permanent there, because a WSL share has no recycle bin."
msgstr "Auf einem WSL-Tab zeigt das Panel die Dateien dieser Distribution statt der Windows-Laufwerke. Löschen ist dort endgültig, weil eine WSL-Freigabe keinen Papierkorb hat."

msgid "Delete {n} item(s) permanently? A WSL share has no recycle bin."
msgstr "{n} Element(e) endgültig löschen? Eine WSL-Freigabe hat keinen Papierkorb."

msgid "{target} already exists. Overwriting deletes it permanently."
msgstr "{target} existiert bereits. Überschreiben löscht es endgültig."
```

- [ ] **Step 3: Verify the catalogs agree**

Run: `npx tsx --test src/i18n.test.ts`
Expected: PASS, 2 tests — identical msgid sets across all seven files, no empty msgstr.

Run: `grep -c '^msgid' locale/*.po`
Expected: 125 in every file (121 before, plus four).

- [ ] **Step 4: Update AGENTS.md**

In the Layout block, add the new source and test files:

```
  wsl.ts              WSL detection + distro lookup: profile command/args -> distro (or '' for the
                      default), one cached `reg.exe query …\Lxss /s` for the default distro name
                      and each DefaultUid, `\\wsl$\<distro>` as the base, and `wslHome` resolving
                      the distro home from its own /etc/passwd. Parsers are pure; reg.exe messages
                      are localized but its data lines are not, so parsing goes by structure
```

Update the two test-count lines — one in the Layout block, one under "Build / test / verify" — from 83 to **104** (sftp-util 32 + logic 4 + i18n 2 + local-path 13 + local-fs.session 13 + local-ops 32 + wsl 8). Confirm against what `npm test` actually prints rather than trusting the arithmetic.

Add a bullet to "Tabby internals that bite", after the local-tabs one:

```
- **WSL tabs are local tabs, and their filesystem is a network share.** `profile.type` is
  `local` and the command is `wsl.exe`; `Shell.fsBase` exists in tabby-local's API but
  `optionsFromShell` never copies it into the profile and the default-distro shell never sets
  it, so the distro comes from the `-d` argument or from the Lxss registry key. The share is
  `\\wsl$\<distro>` for WSL1 and WSL2 alike. With a base set, `LocalFsSession` and `local-ops`
  speak the distribution's own posix paths and `displayPath` is the identity — the `\\wsl$`
  form is shown to nobody, only handed to `fs` and to an external editor. **Everything the 9p
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
  a second base kind with a bin would need its own flag.
```

Update the Status section's local-tabs bullet to mention WSL:

```
- The panel also runs on local terminal tabs as a plain file explorer (`localTabs`, on by
  default), backed by the local filesystem; on a WSL tab it browses that distribution instead
  (`wslTabs`, on by default, setting shown only on win32). Upload/download affordances and the
  owner/group columns are hidden there, chmod is posix-only, delete goes to the recycle bin —
  except on WSL, where there is none and it is permanent — and "edit locally" becomes a direct
  editor spawn with no temp copy.
```

- [ ] **Step 5: Update README.md**

Add a `wslTabs` row to the config table beside `localTabs`, and extend the local-tabs feature bullet:

```
| `wslTabs` | `true` | On a WSL tab, browse that distribution filesystem instead of the Windows drives. Windows only. Delete and overwrite are permanent there — a WSL share has no recycle bin. |
```

- [ ] **Step 6: Full verification**

Run: `npx tsc --noEmit -p tsconfig.json && npm test && npm run build`
Expected: clean, every test passing, `dist/index.js` emitted.

- [ ] **Step 7: Commit**

```bash
git add locale/ AGENTS.md README.md
git commit -m "docs: translate and record the WSL-tab explorer

Four new msgids in all seven catalogs, and an AGENTS.md entry for what the 9p
redirector gets wrong — the fake mode, the symlink calls that all throw while the
dirent flags stay correct, dev always 0, and the missing recycle bin. Every one of
those is load-bearing somewhere in the code and none of them is a bug to go fix."
```

---

## Manual verification in a running Tabby

The build gate checks neither templates nor Angular module scope (see AGENTS.md), so these have to be seen. Restart Tabby fully — plugins scan only at startup.

- [ ] Open a WSL tab. The panel opens in the distro home (`/home/<user>`), not in `C:\`.
- [ ] The path bar shows `/home/<user>`, not `\\wsl$\…` and not `/wsl$/…`.
- [ ] `/` lists the distro root, not drive letters. `/bin` and `/lib` appear as symlink rows.
- [ ] Create a directory and a file at `/tmp`, rename one, then delete it: the confirmation says permanent and names no recycle bin. Shift+Delete skips the confirmation.
- [ ] Copy a file into a folder that already holds one with that name: the prompt says overwriting deletes permanently, and Overwrite replaces it.
- [ ] Copy path on a file yields `/home/<user>/…`.
- [ ] Double-click a text file: it opens in the configured editor, and saving writes back into the distro.
- [ ] Open an ordinary local (PowerShell/cmd) tab in the same window: it still shows drive letters, deletes to the recycle bin, and Copy path still yields `C:\…`.
- [ ] Split a WSL pane beside an SSH pane and move focus between them; the panel follows the focused pane and does not carry a path across.
- [ ] Settings → SFTP Panel shows the WSL toggle. Turn it off, restart, reopen a WSL tab: it shows the Windows filesystem again.

## Self-review notes

Checked against the spec section by section:

- §1 detection → Task 2. §2 base → Tasks 1, 3, 4, 5, 6. §3 start dir and `~` → Task 6 steps 6. §4 permanent delete → Task 4 (removal) and Task 6 step 5 (wording). §5 symlinks → Task 3. §6 config → Task 5. §7 unchanged behaviour → Task 6 steps 1-3 (Copy path, editor path) and no change to the perms gating, as specified. §8 testing → Tasks 1-4. §9 known limits → Task 7 step 4.
- One spec statement is refined by measurement: §5 says a symlink row carries no size or mtime; the probes then showed symlinks cannot be **opened** either (`readdir` on `/bin` is `ENOENT`, not just `lstat`). Task 3's comment and Task 7's AGENTS.md entry both record that, and the manual checklist only asks that the rows appear.
