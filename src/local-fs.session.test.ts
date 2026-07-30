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
