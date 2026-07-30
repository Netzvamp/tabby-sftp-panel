import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { toVirtualPath } from './local-path'

// Overwrite routes the destination through Electron's recycle bin (shell.trashItem), which does
// not exist under node:test — stand in for it, recording what was binned so the tests can assert
// the routing, and failing on demand ('bin-fails' in the path) to cover an unusable bin.
const nodeRequire = createRequire(import.meta.url)
const binned: string[] = []
// Fires right after a successful bin — lets a test simulate the source vanishing mid-operation.
let afterBin: (() => void) | null = null
const electronStub = {
    shell: {
        trashItem: async (p: string) => {
            if (p.includes('bin-fails')) { throw new Error('the recycle bin refused this item') }
            // The real trashItem REJECTS on a missing path (fs.rm({force:true}) used to no-op),
            // so the stub must too or it cannot see a caller that bins blind.
            if (!existsSync(p)) { throw new Error(`ENOENT: no such file or directory, trashItem '${p}'`) }
            binned.push(p)
            rmSync(p, { recursive: true, force: true })
            afterBin?.()
        },
    },
}
;(globalThis as any).window = { require: (m: string) => m === 'electron' ? electronStub : nodeRequire(m) }
const { localCopy, localMove, localTrash, localExists, localRefusal } = await import('./local-ops')

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

// The same directory spelled with different case. On a case-INSENSITIVE volume (every Windows
// volume by default, macOS by default) this names the very same folder, so copy/move into it is
// the item onto itself — the case a resolved-string compare misses and `fs.cp`'s dev+ino check
// catches. On a case-SENSITIVE volume the very same call is a legitimate copy into a directory
// that merely does not exist yet, and `fs.cp` creates the missing parent, so it MUST succeed
// there. Only the refusal is probe-gated; the source surviving is asserted either way, and that
// is the assertion that fails loudly if a future change starts binning the source.
const caseVariant = (dir: string) => join(dirname(dir), basename(dir).replace('sftp-panel-ops-', 'SFTP-PANEL-OPS-'))

test('copying an item into a case-different spelling of its own directory does not destroy it', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'hello')
        const other = caseVariant(dir)
        const insensitive = existsSync(other)
        assert.equal(await localRefusal(vdir + '/a.txt', toVirtualPath(other)) !== null, insensitive)
        const err = await localCopy(vdir + '/a.txt', toVirtualPath(other), true)
        if (insensitive) {
            assert.ok(err, 'must refuse, not bin the source and then fail the copy')
            assert.match(err as string, /source and the destination are the same/)
        } else {
            assert.equal(err, null, 'on a case-sensitive volume this is an ordinary copy elsewhere')
        }
        assert.equal(readFileSync(join(dir, 'a.txt')).toString(), 'hello', 'the source must survive')
    })
})

test('moving an item into a case-different spelling of its own directory does not destroy it', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'hello')
        const other = caseVariant(dir)
        const insensitive = existsSync(other)
        const err = await localMove(vdir + '/a.txt', toVirtualPath(other), true)
        // Case-sensitive volume: the destination directory genuinely does not exist and rename
        // does not create it, so this errors for an ordinary reason rather than being refused.
        assert.ok(err)
        if (insensitive) { assert.match(err as string, /source and the destination are the same/) }
        assert.equal(readFileSync(join(dir, 'a.txt')).toString(), 'hello', 'the source must survive')
    })
})

test('overwrite sends the destination to the recycle bin, not fs.rm', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'new')
        mkdirSync(join(dir, 'dest'))
        writeFileSync(join(dir, 'dest', 'a.txt'), 'old')
        binned.length = 0
        assert.equal(await localCopy(vdir + '/a.txt', vdir + '/dest', true), null)
        assert.deepEqual(binned, [join(dir, 'dest', 'a.txt')])
    })
})

test('an unusable recycle bin fails the overwrite and leaves the destination alone', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'new')
        mkdirSync(join(dir, 'bin-fails'))
        writeFileSync(join(dir, 'bin-fails', 'a.txt'), 'old')
        const err = await localCopy(vdir + '/a.txt', vdir + '/bin-fails', true)
        assert.match(err as string, /recycle bin/)
        assert.equal(readFileSync(join(dir, 'bin-fails', 'a.txt')).toString(), 'old')
    })
})

test('an overwrite that fails after the removal says the destination is already in the bin', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'new')
        mkdirSync(join(dir, 'dest'))
        writeFileSync(join(dir, 'dest', 'a.txt'), 'old')
        // The source disappears in the window between the bin and the copy — the real-world shape
        // is a locked file (EBUSY/EACCES on Windows) or ENOSPC, which a test cannot stage portably.
        afterBin = () => rmSync(join(dir, 'a.txt'))
        try {
            const err = await localCopy(vdir + '/a.txt', vdir + '/dest', true)
            assert.match(err as string, /already been moved to the recycle bin/)
        } finally { afterBin = null }
    })
})

test('an operation that cannot succeed never bins the destination first', async () => {
    await withTempDir(async (dir, vdir) => {
        mkdirSync(join(dir, 'dest'))
        writeFileSync(join(dir, 'dest', 'gone.txt'), 'old')
        binned.length = 0
        // Source vanished before we started: knowable from its stat, so bail before removing.
        const err = await localCopy(vdir + '/gone.txt', vdir + '/dest', true)
        assert.match(err as string, /no longer exists/)
        assert.deepEqual(binned, [], 'nothing may be binned for an operation that cannot run')
        assert.equal(readFileSync(join(dir, 'dest', 'gone.txt')).toString(), 'old')
    })
})

test('a destination deleted while the prompt was open counts as already cleared', async () => {
    await withTempDir(async (dir, vdir) => {
        writeFileSync(join(dir, 'a.txt'), 'new')
        mkdirSync(join(dir, 'dest'))
        binned.length = 0
        // localExists said the destination was there; the user then deleted it in their file
        // manager and clicked Overwrite. trashItem would reject on the missing path — don't call it.
        assert.equal(await localCopy(vdir + '/a.txt', vdir + '/dest', true), null)
        assert.equal(readFileSync(join(dir, 'dest', 'a.txt')).toString(), 'new')
        assert.deepEqual(binned, [])
    })
})

test('copying or moving a folder into its own subfolder is refused before anything is binned', async () => {
    await withTempDir(async (dir, vdir) => {
        // <root>/b/c/b: dev+ino of the endpoints differ, so only the containment check sees it.
        mkdirSync(join(dir, 'b', 'c', 'b'), { recursive: true })
        writeFileSync(join(dir, 'b', 'keep.txt'), 'x')
        writeFileSync(join(dir, 'b', 'c', 'b', 'inner.txt'), 'y')
        binned.length = 0
        for (const op of [localCopy, localMove]) {
            const err = await op(vdir + '/b', vdir + '/b/c', true)
            assert.match(err as string, /one is inside the other/)
        }
        // Case-different spelling of the same subfolder: string comparison misses it on a
        // case-insensitive volume, the dev+ino ancestor walk does not.
        if (existsSync(join(dir, 'B', 'C'))) {
            assert.match(await localCopy(vdir + '/b', vdir + '/B/C', true) as string, /one is inside the other/)
        }
        assert.deepEqual(binned, [], 'the destination lives INSIDE the source — it must not be binned')
        assert.equal(readFileSync(join(dir, 'b', 'c', 'b', 'inner.txt')).toString(), 'y')
        assert.equal(readFileSync(join(dir, 'b', 'keep.txt')).toString(), 'x')
    })
})

test('a destination that is an ANCESTOR of the source is refused too', async () => {
    await withTempDir(async (dir, vdir) => {
        // Flattening <root>/b/b into <root>: `to` is <root>/b, which CONTAINS the source. Raw fs.cp
        // succeeds on this shape, so nothing downstream would catch it — the guard has to be ours.
        mkdirSync(join(dir, 'b', 'b'), { recursive: true })
        writeFileSync(join(dir, 'b', 'b', 'deep.txt'), 'x')
        writeFileSync(join(dir, 'b', 'sibling.txt'), 'y')
        binned.length = 0
        for (const op of [localCopy, localMove]) {
            assert.match(await op(vdir + '/b/b', vdir, true) as string, /one is inside the other/)
        }
        assert.deepEqual(binned, [], 'the destination CONTAINS the source — it must not be binned')
        assert.equal(readFileSync(join(dir, 'b', 'b', 'deep.txt')).toString(), 'x')
        assert.equal(readFileSync(join(dir, 'b', 'sibling.txt')).toString(), 'y')
    })
})

test('ordinary moves up the tree are not refused by the symmetric check', async () => {
    await withTempDir(async (dir, vdir) => {
        // Up one level: the destination is the source's own parent, so `to` IS `from` — caught as
        // "the same", not as an overlap, and the panel never offers it as an overwrite.
        mkdirSync(join(dir, 'a', 'b'), { recursive: true })
        writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x')
        assert.match(await localRefusal(vdir + '/a/b', vdir + '/a') as string, /source and the destination are the same/)
        // Up two levels: `to` lands BESIDE the source's parent, nested in neither direction.
        assert.equal(await localRefusal(vdir + '/a/b', vdir), null)
        assert.equal(await localMove(vdir + '/a/b', vdir), null)
        assert.equal(readFileSync(join(dir, 'b', 'f.txt')).toString(), 'x')
        assert.equal(existsSync(join(dir, 'a', 'b')), false)
    })
})

test('a dangling symlink can still be copied and moved', async (t) => {
    await withTempDir(async (dir, vdir) => {
        mkdirSync(join(dir, 'dest'))
        try {
            symlinkSync(join(dir, 'nowhere.txt'), join(dir, 'broken'), 'file')
        } catch (e: any) {
            if (e.code === 'EPERM') { t.skip('no permission to create links on this machine'); return }
            throw e
        }
        // stat() fails on it, lstat() does not — the source bail must use the fallback or an
        // ordinary broken link (a visible, selectable row) reads as "the item no longer exists".
        assert.equal(await localRefusal(vdir + '/broken', vdir + '/dest'), null)
        assert.equal(await localCopy(vdir + '/broken', vdir + '/dest'), null)
        assert.equal(lstatSync(join(dir, 'dest', 'broken')).isSymbolicLink(), true)
    })
})

test('containment is caught through a symlinked destination, which string paths cannot see', async (t) => {
    await withTempDir(async (dir, vdir) => {
        mkdirSync(join(dir, 'b', 'c'), { recursive: true })
        writeFileSync(join(dir, 'b', 'keep.txt'), 'x')
        try {
            // 'junction' needs no elevation on Windows; the type is ignored on posix.
            symlinkSync(join(dir, 'b'), join(dir, 'link'), 'junction')
        } catch (e: any) {
            if (e.code === 'EPERM') { t.skip('no permission to create links on this machine'); return }
            throw e
        }
        // relative('<root>/b', '<root>/link/c/b') is '../link/c/b' — outside, as far as strings
        // know. Only the dev+ino ancestor walk sees that <root>/link IS <root>/b.
        binned.length = 0
        assert.match(await localCopy(vdir + '/b', vdir + '/link/c', true) as string, /one is inside the other/)
        assert.deepEqual(binned, [])
        assert.equal(readFileSync(join(dir, 'b', 'keep.txt')).toString(), 'x')
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
