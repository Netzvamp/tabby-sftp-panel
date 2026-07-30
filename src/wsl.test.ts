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
// on a real machine. Note the trailing ShortcutPath line with an empty value (reg.exe prints
// nothing after the type token) and the BasePath value containing backslashes. The empty
// value is parsed without derailing the surrounding lines, but ShortcutPath itself is not part
// of parseLxss's returned shape ({ defaultDistro, uids }), so its emptiness isn't observable
// through that return value — see the dedicated DefaultUid test below for a field where an
// empty body IS observable.
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

test('parseLxss falls back to 1000 when DefaultUid has an empty body, and does not corrupt the block after it', () => {
    // reg.exe prints an empty REG_DWORD with nothing after the type token — not even a
    // trailing space — for a distro whose uid was never configured that way. Unlike an
    // empty DistributionName (unobservable: both undefined and '' are falsy), an empty
    // DefaultUid IS observable through uids: parseInt('', 16) is NaN, and without a
    // guard that NaN — not the 1000 fallback — is what a caller would see.
    const out = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss
    DefaultDistribution    REG_SZ    {bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}
    State    REG_DWORD    0x1
    DistributionName    REG_SZ    Debian
    DefaultUid    REG_DWORD

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}
    State    REG_DWORD    0x1
    DistributionName    REG_SZ    Ubuntu
    DefaultUid    REG_DWORD    0x0
`
    const info = parseLxss(out)
    // The empty-body DefaultUid must fall back to 1000, not NaN.
    assert.equal(info.uids.Debian, 1000)
    // The block AFTER the empty-value line must still parse its own, DIFFERENT uid
    // correctly (0, not 1000 and not NaN) — proof that the empty line above it did not
    // leak into or corrupt this block's own DefaultUid line.
    assert.equal(info.uids.Ubuntu, 0)
    // The DefaultDistribution GUID (the block after the empty-DefaultUid one) still resolves.
    assert.equal(info.defaultDistro, 'Ubuntu')
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
