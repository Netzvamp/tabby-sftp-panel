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

/** `fs.stat` or null. STAT, never lstat — see the note on `statOf` below. */
async function statOf (p: string): Promise<any | null> {
    return fsp.stat(p).then((s: any) => s, () => null)
}

/** Whether `destDir` already holds an entry named `name` — the collision check the panel
 *  runs before a local copy/move, since fs.cp/fs.rename overwrite silently and there is no
 *  server-side fallback to recover a clobbered local file from.
 *
 *  COUPLING, do not break: this, `sameEntry` and `clearDestination` must all use the SAME stat
 *  flavour (`stat`, which follows symlinks — not `lstat`). A dangling symlink is safe today only
 *  because all three fail on it identically: it is reported as "no collision", so no prompt, no
 *  removal, and fs.cp/fs.rename deal with it. Switch one of them to `lstat` and that agreement
 *  breaks silently — the prompt would fire for an entry `sameEntry` cannot see. */
export async function localExists (destDir: string, name: string): Promise<boolean> {
    try {
        return await statOf(nodePath.join(toNativeFsPath(destDir), name)) !== null
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
function sameEntry (a: any, b: any | null): boolean {
    return !!b && a.dev === b.dev && a.ino === b.ino
}

/** `fs.cp` refuses TWO things, and missing the second one is the same class of bug as missing
 *  the first: copying a directory into a subdirectory of itself (`<root>/b` → `<root>/b/c/b`).
 *  dev+ino of the endpoints compare unequal there, so without this the destination — a path
 *  INSIDE the source tree — would be binned before fs.cp/fs.rename ever got to refuse.
 *
 *  Two passes, because each alone has a hole:
 *   - `nodePath.relative`: pure string work, and it is the only pass that sees a destination
 *     whose ancestors do not exist yet. `win32.relative` folds case; `posix.relative` does not.
 *   - walking `to`'s existing ancestors and comparing dev+ino against the source: exact, and the
 *     pass that survives a differently-cased spelling of a real directory (the Finding A lesson,
 *     applied to containment — it is what covers macOS's case-insensitive default volume, where
 *     posix.relative would compare unequal). */
async function inside (from: string, srcStat: any, to: string): Promise<boolean> {
    const rel = nodePath.relative(from, to)
    if (rel !== '' && rel !== '..' && !rel.startsWith('..' + nodePath.sep) && !nodePath.isAbsolute(rel)) { return true }
    let dir = nodePath.dirname(to)
    let prev = ''
    while (dir !== prev) {
        if (sameEntry(srcStat, await statOf(dir))) { return true }
        prev = dir
        dir = nodePath.dirname(dir)
    }
    return false
}

const SAME_ENTRY = 'the source and the destination are the same'
const INSIDE_SELF = 'the destination is inside the item itself'

/** Everything that makes a copy/move impossible BEFORE anything is removed: source and
 *  destination resolved natively, or the message to report instead.
 *
 *  The panel calls this (via `localRefusal`) ahead of the collision prompt, so a doomed operation
 *  is never dressed up as an overwrite the user gets asked to confirm; `localCopy`/`localMove`
 *  call it again as the backstop that keeps `clearDestination` from binning something it must
 *  not. */
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
    // One source stat serves three purposes, and it comes first so that a doomed operation never
    // bins a destination on its way to failing: the vanished-source bail, the identity check and
    // the containment check.
    const srcStat = await statOf(from)
    if (!srcStat) { return `${from} no longer exists` }
    if (sameEntry(srcStat, await statOf(to))) { return SAME_ENTRY }
    if (await inside(from, srcStat, to)) { return INSIDE_SELF }
    return { from, to }
}

/** Why a copy/move of `src` into `destDir` cannot proceed, or null. */
export async function localRefusal (src: string, destDir: string): Promise<string | null> {
    const ends = await endpoints(src, destDir)
    return typeof ends === 'string' ? ends : null
}

/** "Overwrite" means REPLACE, for both files and directories and for both copy and move:
 *  fs.rename cannot replace a non-empty directory at all (EPERM/ENOTEMPTY) and fs.cp merges
 *  into one, so the destination goes first once the user has consented.
 *  Via the RECYCLE BIN, like `localTrash`: consenting to "Overwrite" is not consent to a
 *  permanent delete, and the panel never hard-deletes locally. A failing bin is reported, never
 *  quietly downgraded to `fs.rm`.
 *  Returns whether anything was actually binned: `fs.rm({force:true})` used to no-op on a missing
 *  path but `trashItem` rejects, and the window between the collision check and here contains a
 *  MODAL DIALOG — a user who resolves the conflict by deleting the destination in their file
 *  manager and then clicks Overwrite must get a successful copy, not ENOENT. */
async function clearDestination (to: string): Promise<boolean> {
    if (!await statOf(to)) { return false }
    await req('electron').shell.trashItem(to)
    return true
}

/** The destination is removed BEFORE the copy/rename, so a failure there (EBUSY/EACCES on a
 *  locked file is routine on Windows, ENOSPC, a source that vanished) leaves it gone. Say so —
 *  the item is in the recycle bin, not lost, and the user cannot tell from a raw errno. */
function afterClear (msg: string, cleared: boolean): string {
    return cleared ? `${msg}; the existing destination had already been moved to the recycle bin` : msg
}

/** Bin the destination when the user consented, or the message to report. `{ cleared }` says
 *  whether anything actually went to the bin, which is what the failure wording keys off. */
async function clear (to: string, overwrite: boolean): Promise<{ cleared: boolean } | string> {
    if (!overwrite) { return { cleared: false } }
    try {
        return { cleared: await clearDestination(to) }
    } catch (e: any) {
        return `could not move the existing destination to the recycle bin: ${e?.message ?? String(e)}`
    }
}

/** Recursive copy of `src` INTO the directory `destDir`, keeping its basename.
 *  `overwrite` (the user said so at the collision prompt) replaces the destination entry. */
export async function localCopy (src: string, destDir: string, overwrite = false): Promise<string | null> {
    const ends = await endpoints(src, destDir)
    if (typeof ends === 'string') { return ends }
    const cleared = await clear(ends.to, overwrite)
    if (typeof cleared === 'string') { return cleared }
    try {
        // Without consent, never clobber: the panel only gets here when the destination did
        // not exist a moment ago, so anything present now appeared behind the user's back.
        await fsp.cp(ends.from, ends.to, { recursive: true, errorOnExist: !overwrite, force: overwrite })
        return null
    } catch (e: any) {
        return afterClear(e?.message ?? String(e), cleared.cleared)
    }
}

/** Move `src` INTO the directory `destDir`. Falls back to copy-then-delete across volumes,
 *  where rename fails with EXDEV. */
export async function localMove (src: string, destDir: string, overwrite = false): Promise<string | null> {
    const ends = await endpoints(src, destDir)
    if (typeof ends === 'string') { return ends }
    const cleared = await clear(ends.to, overwrite)
    if (typeof cleared === 'string') { return cleared }
    try {
        await fsp.rename(ends.from, ends.to)
        return null
    } catch (e: any) {
        if (e?.code !== 'EXDEV') { return afterClear(e?.message ?? String(e), cleared.cleared) }
        // The destination is already in the bin when overwrite was consented to, so the copy leg
        // must NOT be asked to overwrite again — there is nothing left to clear, and asking
        // trashItem to bin a path that no longer exists would fail the move outright.
        const copyErr = await localCopy(src, destDir, false)
        // Same wording as every other leg: a partial copy is not the only thing the user needs to
        // know — their original destination is in the bin, and nothing else here would say so.
        if (copyErr) {
            return afterClear(`cross-device move stopped partway through the copy; the destination may hold a partial copy: ${copyErr}`, cleared.cleared)
        }
        try {
            await fsp.rm(ends.from, { recursive: true, force: true })
            return null
        } catch (e2: any) {
            return `copied, but could not remove the source: ${e2?.message ?? String(e2)}`
        }
    }
}

/** Move to the OS recycle bin. Deleting a local file has no remote copy to fall back on,
 *  and the OS already owns undo, so the panel never hard-deletes locally — `clearDestination`
 *  routes an Overwrite through the same call for the same reason. `electron` is required lazily
 *  (here and there) so importing this module never needs it: the fs helpers stay unit-testable,
 *  and a test that does exercise a bin can stub `window.require('electron')`. */
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
