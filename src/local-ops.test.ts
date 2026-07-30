import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { toVirtualPath } from './local-path'

;(globalThis as any).window = { require: createRequire(import.meta.url) }
const { localCopy, localMove, localTrash, localExists } = await import('./local-ops')

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

test('localMove relocates a directory tree and removes the source', async () => {
    await withTempDir(async (dir, vdir) => {
        mkdirSync(join(dir, 'tree', 'sub'), { recursive: true })
        writeFileSync(join(dir, 'tree', 'sub', 'deep.txt'), 'x')
        mkdirSync(join(dir, 'dest'))
        assert.equal(await localMove(vdir + '/tree', vdir + '/dest'), null)
        assert.equal(readFileSync(join(dir, 'dest', 'tree', 'sub', 'deep.txt')).toString(), 'x')
        assert.equal(existsSync(join(dir, 'tree')), false)
    })
})

test('localMove reports a message instead of throwing when the source is missing', async () => {
    await withTempDir(async (_dir, vdir) => {
        const err = await localMove(vdir + '/nope', vdir)
        assert.ok(typeof err === 'string' && err.length > 0)
    })
})

// "Overwrite" (what the collision prompt offers) means REPLACE — for both ops and for both
// files and directories. These four are the cases that shipped broken: fs.rename cannot
// replace a non-empty directory and fs.cp merges into one, so an unguarded Overwrite either
// failed with a raw errno or silently left destination-only files behind.
test('localCopy with overwrite replaces an existing file', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'new')
        mkdirSync(join(dir, 'dest'))
        writeFileSync(join(dir, 'dest', 'a.txt'), 'old')
        assert.equal(await localCopy(vdir + '/a.txt', vdir + '/dest', true), null)
        assert.equal(readFileSync(join(dir, 'dest', 'a.txt')).toString(), 'new')
    })
})

test('localCopy with overwrite replaces a directory instead of merging into it', async () => {
    await withTempDir(async (dir, vdir) => {
        mkdirSync(join(dir, 'tree'))
        writeFileSync(join(dir, 'tree', 'new.txt'), 'x')
        mkdirSync(join(dir, 'dest', 'tree'), { recursive: true })
        writeFileSync(join(dir, 'dest', 'tree', 'stale.txt'), 'y')
        assert.equal(await localCopy(vdir + '/tree', vdir + '/dest', true), null)
        assert.equal(readFileSync(join(dir, 'dest', 'tree', 'new.txt')).toString(), 'x')
        assert.equal(existsSync(join(dir, 'dest', 'tree', 'stale.txt')), false, 'overwrite must not merge')
        assert.ok(existsSync(join(dir, 'tree', 'new.txt')), 'source must survive a copy')
    })
})

test('localMove with overwrite replaces an existing file', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'new')
        mkdirSync(join(dir, 'dest'))
        writeFileSync(join(dir, 'dest', 'a.txt'), 'old')
        assert.equal(await localMove(vdir + '/a.txt', vdir + '/dest', true), null)
        assert.equal(readFileSync(join(dir, 'dest', 'a.txt')).toString(), 'new')
        assert.equal(existsSync(join(dir, 'a.txt')), false)
    })
})

test('localMove with overwrite replaces a non-empty directory', async () => {
    await withTempDir(async (dir, vdir) => {
        mkdirSync(join(dir, 'tree'))
        writeFileSync(join(dir, 'tree', 'new.txt'), 'x')
        mkdirSync(join(dir, 'dest', 'tree'), { recursive: true })
        writeFileSync(join(dir, 'dest', 'tree', 'stale.txt'), 'y')
        assert.equal(await localMove(vdir + '/tree', vdir + '/dest', true), null)
        assert.equal(readFileSync(join(dir, 'dest', 'tree', 'new.txt')).toString(), 'x')
        assert.equal(existsSync(join(dir, 'dest', 'tree', 'stale.txt')), false, 'overwrite must not merge')
        assert.equal(existsSync(join(dir, 'tree')), false)
    })
})

test('localCopy without consent refuses to clobber a destination that appeared meanwhile', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'new')
        mkdirSync(join(dir, 'dest'))
        writeFileSync(join(dir, 'dest', 'a.txt'), 'old')
        assert.ok(await localCopy(vdir + '/a.txt', vdir + '/dest'), 'must report, not overwrite')
        assert.equal(readFileSync(join(dir, 'dest', 'a.txt')).toString(), 'old')
    })
})

test('copying or moving an item into its own directory is refused', async () => {
    // With overwrite that would remove the destination — which IS the source — first.
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'hello')
        assert.ok(await localCopy(vdir + '/a.txt', vdir, true))
        assert.ok(await localMove(vdir + '/a.txt', vdir, true))
        assert.equal(readFileSync(join(dir, 'a.txt')).toString(), 'hello')
    })
})

test('a drive root is refused as a copy, move or delete source', { skip: process.platform !== 'win32' }, async () => {
    // basename('C:\\') is '' , so join(dest, '') collapses to dest: an unguarded copy of the
    // 'C:' row would recursively clone the whole drive over the destination.
    assert.ok(await localCopy('/C:', '/C:/some-dest'))
    assert.ok(await localMove('/C:', '/C:/some-dest'))
    assert.ok(await localTrash('/C:'))
})

test('localExists reports true for a colliding basename and false otherwise', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'hello')
        assert.equal(await localExists(vdir, 'a.txt'), true)
        assert.equal(await localExists(vdir, 'nope.txt'), false)
    })
})
