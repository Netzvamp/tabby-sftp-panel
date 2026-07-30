import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { toVirtualPath } from './local-path'

;(globalThis as any).window = { require: createRequire(import.meta.url) }
const { localCopy, localMove, localExists } = await import('./local-ops')

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

test('localExists reports true for a colliding basename and false otherwise', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'hello')
        assert.equal(await localExists(vdir, 'a.txt'), true)
        assert.equal(await localExists(vdir, 'nope.txt'), false)
    })
})
