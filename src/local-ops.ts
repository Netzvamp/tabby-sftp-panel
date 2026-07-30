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

/** Source and destination resolved natively, or a message if either is unusable.
 *  Copying/moving an item onto itself would (with `overwrite`) delete the source first, so
 *  that case is refused rather than handled. */
function endpoints (src: string, destDir: string): { from: string, to: string } | string {
    const refused = refuseDriveRoot(src)
    if (refused) { return refused }
    let from: string, to: string
    try {
        from = toNativeFsPath(src)
        to = nodePath.join(toNativeFsPath(destDir), nodePath.basename(from))
    } catch (e: any) {
        return e?.message ?? String(e)
    }
    if (nodePath.resolve(from) === nodePath.resolve(to)) { return 'the source and the destination are the same' }
    return { from, to }
}

/** "Overwrite" means REPLACE, for both files and directories and for both copy and move:
 *  fs.rename cannot replace a non-empty directory at all (EPERM/ENOTEMPTY) and fs.cp merges
 *  into one, so the destination is removed first once the user has consented. */
async function clearDestination (to: string): Promise<void> {
    await fsp.rm(to, { recursive: true, force: true })
}

/** Recursive copy of `src` INTO the directory `destDir`, keeping its basename.
 *  `overwrite` (the user said so at the collision prompt) replaces the destination entry. */
export async function localCopy (src: string, destDir: string, overwrite = false): Promise<string | null> {
    const ends = endpoints(src, destDir)
    if (typeof ends === 'string') { return ends }
    try {
        if (overwrite) { await clearDestination(ends.to) }
        // Without consent, never clobber: the panel only gets here when the destination did
        // not exist a moment ago, so anything present now appeared behind the user's back.
        await fsp.cp(ends.from, ends.to, { recursive: true, errorOnExist: !overwrite, force: overwrite })
        return null
    } catch (e: any) {
        return e?.message ?? String(e)
    }
}

/** Move `src` INTO the directory `destDir`. Falls back to copy-then-delete across volumes,
 *  where rename fails with EXDEV. */
export async function localMove (src: string, destDir: string, overwrite = false): Promise<string | null> {
    const ends = endpoints(src, destDir)
    if (typeof ends === 'string') { return ends }
    try {
        if (overwrite) { await clearDestination(ends.to) }
        await fsp.rename(ends.from, ends.to)
        return null
    } catch (e: any) {
        if (e?.code !== 'EXDEV') { return e?.message ?? String(e) }
        // The destination is already gone when overwrite was consented to, so the copy leg
        // must not be asked to overwrite again (and must not merge into a leftover).
        const copyErr = await localCopy(src, destDir, overwrite)
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
