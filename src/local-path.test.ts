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
