import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { toNativePath, toNativeFsPath, toVirtualPath, isVirtualRoot, isDriveRoot, driveRoots } from './local-path'

// This file runs as ESM (src/package.json sets "type": "module"), which has no ambient
// `require` — shim it so a test can reach node:path the same way the rest of the file
// reaches node:test.
const require = createRequire(import.meta.url)

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

test('toNativePath yields a RELATIVE path for a win32 path with no drive', () => {
    // Pinned because it is a trap, not a feature: 'foo' resolves against Tabby's own working
    // directory. Nothing may hand this to fs — that is what toNativeFsPath is for.
    assert.equal(toNativePath('/foo', true), 'foo')
    assert.equal(toNativePath('/foo/bar', true), 'foo\\bar')
    // UNC survives toVirtualPath only as a drive-less path, so it lands here too.
    assert.equal(toNativePath(toVirtualPath('\\\\server\\share\\x', true), true), 'server\\share\\x')
})

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

test('isDriveRoot matches only a bare drive, and only on win32', () => {
    assert.equal(isDriveRoot('/C:', true), true)
    assert.equal(isDriveRoot('/C:/', true), true)
    assert.equal(isDriveRoot('/C:/Users', true), false)
    assert.equal(isDriveRoot('/', true), false)
    assert.equal(isDriveRoot('/C:', false), false)
})

test('driveRoots probes A: through Z: and returns virtual paths', () => {
    const probed: string[] = []
    const roots = driveRoots(p => { probed.push(p); return p === 'C:\\' || p === 'Z:\\' })
    assert.deepEqual(roots, ['/C:', '/Z:'])
    assert.equal(probed.length, 26)
    assert.equal(probed[0], 'A:\\')
    assert.equal(probed[25], 'Z:\\')
})
