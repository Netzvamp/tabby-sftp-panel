import { toNativeFsPath, isDriveRoot } from './local-path'

const req = (window as any).require
const fs = req('fs'), fsp = fs.promises, nodePath = req('path')

// The three operations the panel does differently on a local tab. Each takes VIRTUAL paths
// and returns null on success or a message on failure, so the panel can log uniformly
// without a try/catch per call site.

/** A drive root has an empty basename, so `join(dest, basename('C:\\'))` collapses to the
 *  destination itself and a "copy C:" would recursively clone the whole system drive over it.
 *  The panel already keeps those rows out of its menus; this is the backstop. */
function refuseDriveRoot (p: string): string | null {
    return isDriveRoot(p) ? `${p} is a drive root — copy, move and delete are not available for it` : null
}

/** Whether `destDir` already holds an entry named `name` — the collision check the panel
 *  runs before a local copy/move, since fs.cp/fs.rename overwrite silently and there is no
 *  server-side fallback to recover a clobbered local file from. */
export async function localExists (destDir: string, name: string): Promise<boolean> {
    try {
        await fsp.stat(nodePath.join(toNativeFsPath(destDir), name))
        return true
    } catch {
        return false
    }
}

/** The same identity test `fs.cp` runs before it refuses (`ERR_FS_CP_EINVAL`): device + inode,
 *  never resolved path STRINGS. `path.win32.resolve` preserves case, so on a case-insensitive
 *  volume — every Windows volume by default, and macOS by default — a destination typed with
 *  different case for the folder the item already sits in compares unequal while naming the very
 *  same file. With `overwrite` that meant binning the SOURCE and then failing the copy.
 *  A destination that does not exist has no identity to collide with. */
async function sameEntry (from: string, to: string): Promise<boolean> {
    try {
        const [a, b] = await Promise.all([fsp.stat(from), fsp.stat(to)])
        return a.dev === b.dev && a.ino === b.ino
    } catch {
        return false
    }
}

const SAME_ENTRY = 'the source and the destination are the same'

/** Whether copy/move would target the very file it is reading. The panel calls this BEFORE the
 *  collision prompt, so a same-entry attempt is refused outright instead of asking the user to
 *  confirm an overwrite that can never happen. */
export async function localSameEntry (src: string, destDir: string): Promise<boolean> {
    try {
        const from = toNativeFsPath(src)
        return await sameEntry(from, nodePath.join(toNativeFsPath(destDir), nodePath.basename(from)))
    } catch {
        return false
    }
}

/** Source and destination resolved natively, or a message if either is unusable. */
async function endpoints (src: string, destDir: string): Promise<{ from: string, to: string } | string> {
    const refused = refuseDriveRoot(src)
    if (refused) { return refused }
    let from: string, to: string
    try {
        from = toNativeFsPath(src)
        to = nodePath.join(toNativeFsPath(destDir), nodePath.basename(from))
    } catch (e: any) {
        return e?.message ?? String(e)
    }
    // Backstop for the panel's own pre-prompt check — and the guard that keeps `clearDestination`
    // from binning the source.
    if (await sameEntry(from, to)) { return SAME_ENTRY }
    return { from, to }
}

/** "Overwrite" means REPLACE, for both files and directories and for both copy and move:
 *  fs.rename cannot replace a non-empty directory at all (EPERM/ENOTEMPTY) and fs.cp merges
 *  into one, so the destination goes first once the user has consented.
 *  Via the RECYCLE BIN, like `localTrash`: consenting to "Overwrite" is not consent to a
 *  permanent delete, and the panel never hard-deletes locally. A failing bin is reported, never
 *  quietly downgraded to `fs.rm`. */
async function clearDestination (to: string): Promise<void> {
    await req('electron').shell.trashItem(to)
}

/** The destination is removed BEFORE the copy/rename, so a failure there (EBUSY/EACCES on a
 *  locked file is routine on Windows, ENOSPC, a source that vanished) leaves it gone. Say so —
 *  the item is in the recycle bin, not lost, and the user cannot tell from a raw errno. */
function afterClear (e: any, cleared: boolean): string {
    const msg = e?.message ?? String(e)
    return cleared ? `${msg}; the existing destination had already been moved to the recycle bin` : msg
}

/** Recursive copy of `src` INTO the directory `destDir`, keeping its basename.
 *  `overwrite` (the user said so at the collision prompt) replaces the destination entry. */
export async function localCopy (src: string, destDir: string, overwrite = false): Promise<string | null> {
    const ends = await endpoints(src, destDir)
    if (typeof ends === 'string') { return ends }
    if (overwrite) {
        try {
            await clearDestination(ends.to)
        } catch (e: any) {
            return `could not move the existing destination to the recycle bin: ${e?.message ?? String(e)}`
        }
    }
    try {
        // Without consent, never clobber: the panel only gets here when the destination did
        // not exist a moment ago, so anything present now appeared behind the user's back.
        await fsp.cp(ends.from, ends.to, { recursive: true, errorOnExist: !overwrite, force: overwrite })
        return null
    } catch (e: any) {
        return afterClear(e, overwrite)
    }
}

/** Move `src` INTO the directory `destDir`. Falls back to copy-then-delete across volumes,
 *  where rename fails with EXDEV. */
export async function localMove (src: string, destDir: string, overwrite = false): Promise<string | null> {
    const ends = await endpoints(src, destDir)
    if (typeof ends === 'string') { return ends }
    if (overwrite) {
        try {
            await clearDestination(ends.to)
        } catch (e: any) {
            return `could not move the existing destination to the recycle bin: ${e?.message ?? String(e)}`
        }
    }
    try {
        await fsp.rename(ends.from, ends.to)
        return null
    } catch (e: any) {
        if (e?.code !== 'EXDEV') { return afterClear(e, overwrite) }
        // The destination is already in the bin when overwrite was consented to, so the copy leg
        // must NOT be asked to overwrite again — there is nothing left to clear, and asking
        // trashItem to bin a path that no longer exists would fail the move outright.
        const copyErr = await localCopy(src, destDir, false)
        if (copyErr) { return `cross-device move stopped partway through the copy; the destination may hold a partial copy: ${copyErr}` }
        try {
            await fsp.rm(ends.from, { recursive: true, force: true })
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
    const refused = refuseDriveRoot(p)
    if (refused) { return refused }
    try {
        await req('electron').shell.trashItem(toNativeFsPath(p))
        return null
    } catch (e: any) {
        return e?.message ?? String(e)
    }
}
