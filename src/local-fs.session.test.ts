import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, symlinkSync } from 'node:fs'
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

test('readlink resolves absolute and relative symlink targets', async (t) => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'target.txt'), 'x')
        try {
            symlinkSync(join(dir, 'target.txt'), join(dir, 'abs-link'))
            symlinkSync('target.txt', join(dir, 'rel-link'))
        } catch (e: any) {
            // Creating symlinks needs elevation or Developer Mode on Windows — skip rather
            // than fail the suite on a machine that hasn't got that turned on.
            if (e.code === 'EPERM') { t.skip('no permission to create symlinks on this machine'); return }
            throw e
        }
        const s = new LocalFsSession()
        assert.equal(await s.readlink(vdir + '/abs-link'), vdir + '/target.txt')
        assert.equal(await s.readlink(vdir + '/rel-link'), 'target.txt')
    })
})

test('open creates a new empty file', async () => {
    await withTempDir(async (dir, vdir) => {
        const s = new LocalFsSession()
        const h = await s.open(vdir + '/new.txt', 0)
        await h.close()
        assert.equal(readFileSync(join(dir, 'new.txt')).length, 0)
    })
})

test('open rejects when the target already exists', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'exists.txt'), 'hi')
        const s = new LocalFsSession()
        await assert.rejects(() => s.open(vdir + '/exists.txt', 0))
    })
})

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
