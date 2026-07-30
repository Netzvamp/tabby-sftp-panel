import { toNativeFsPath, isDriveRoot } from './local-path'

const req = (window as any).require
const fs = req('fs'), fsp = fs.promises, nodePath = req('path')

// The three operations the panel does differently on a local tab. Each takes VIRTUAL paths
// and returns null on success or a message on failure, so the panel can log uniformly
// without a try/catch per call site.

/** A drive root has an empty basename, so `join(dest, basename('C:\\'))` collapses to the
 *  destination itself and a "copy C:" would recursively clone the whole system drive over it.
 *  The panel already keeps those rows out of its menus; this is the backstop.
 *  A based session has no drives at all — every path in it is a posix path in the
 *  distribution — so the check is inert there. */
function refuseDriveRoot (p: string, base: string): string | null {
    return !base && isDriveRoot(p) ? `${p} is a drive root — copy, move and delete are not available for it` : null
}

/** `fs.stat` or null. STAT, which FOLLOWS symlinks — see the coupling note on `localExists`. */
async function statOf (p: string): Promise<any | null> {
    return fsp.stat(p).then((s: any) => s, () => null)
}

/** `fs.lstat` or null. Used in exactly one place: the source-side bail, so that a DANGLING
 *  symlink is still copyable/movable (`fs.cp` with dereference off and `fs.rename` both handle
 *  one, and `local-fs.session.ts` lists entries with `lstat`, so broken links are selectable
 *  rows). Never used for the destination — see the coupling note on `localExists`. */
async function lstatOf (p: string): Promise<any | null> {
    return fsp.lstat(p).then((s: any) => s, () => null)
}

/** Whether `destDir` already holds an entry named `name` — the collision check the panel
 *  runs before a local copy/move, since fs.cp/fs.rename overwrite silently and there is no
 *  server-side fallback to recover a clobbered local file from.
 *
 *  COUPLING, do not break: every DESTINATION-side check — this one, `sameEntry`'s `to` stat and
 *  `clearDestination` — must use the SAME stat flavour (`stat`, which follows symlinks, not
 *  `lstat`). A dangling symlink at the destination is safe only because all three fail on it
 *  identically: it is reported as "no collision", so no prompt, no removal, and fs.cp/fs.rename
 *  deal with it. Switch one of them to `lstat` and that agreement breaks silently — the prompt
 *  would fire for an entry `sameEntry` cannot see. `nests()`'s ancestor walk is `stat`-bound for a
 *  second reason: following links is what makes it catch a destination reached through a junction.
 *  The SOURCE-side bail in `endpoints` is the deliberate exception (`stat ?? lstat`): a dangling
 *  link is a real, copyable item, and treating it as "no longer exists" blocked a valid
 *  operation. It is one-sided on purpose — it never decides whether to remove anything. */
export async function localExists (destDir: string, name: string, base = ''): Promise<boolean> {
    try {
        return await statOf(nodePath.join(toNativeFsPath(destDir, base), name)) !== null
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

/** True when `inner` sits inside the tree rooted at `outer`. Two passes, because each alone has
 *  a hole:
 *   - `nodePath.relative`: pure string work, and the only pass that sees a path whose ancestors
 *     do not exist yet. `win32.relative` folds case; `posix.relative` does not.
 *   - walking `inner`'s existing ancestors and comparing dev+ino against `outer`: exact, and the
 *     pass that survives a differently-cased spelling of a real directory (the same lesson as
 *     `sameEntry` — it covers macOS's case-insensitive default volume, where posix.relative
 *     compares unequal) and a destination reached through a symlink or junction.
 *  `outerStat` may be null (nothing to compare against — string pass only). */
async function nests (outer: string, outerStat: any | null, inner: string): Promise<boolean> {
    const rel = nodePath.relative(outer, inner)
    if (rel !== '' && rel !== '..' && !rel.startsWith('..' + nodePath.sep) && !nodePath.isAbsolute(rel)) { return true }
    if (!outerStat) { return false }
    let dir = nodePath.dirname(inner)
    let prev = ''
    while (dir !== prev) {
        if (sameEntry(outerStat, await statOf(dir))) { return true }
        prev = dir
        dir = nodePath.dirname(dir)
    }
    return false
}

const SAME_ENTRY = 'the source and the destination are the same'
// Both directions, one message: it has to read correctly for "folder into its own subfolder" AND
// for "folder out of a folder that shares its name" (see the OVERLAP check in endpoints).
const OVERLAP = 'the item and the destination overlap — one is inside the other'

/** Everything that makes a copy/move impossible BEFORE anything is removed: source and
 *  destination resolved natively, or the message to report instead.
 *
 *  The panel calls this (via `localRefusal`) ahead of the collision prompt, so a doomed operation
 *  is never dressed up as an overwrite the user gets asked to confirm; `localCopy`/`localMove`
 *  call it again as the backstop that keeps `clearDestination` from binning something it must
 *  not. */
async function endpoints (src: string, destDir: string, base: string): Promise<{ from: string, to: string } | string> {
    const refused = refuseDriveRoot(src, base)
    if (refused) { return refused }
    let from: string, to: string
    try {
        from = toNativeFsPath(src, base)
        to = nodePath.join(toNativeFsPath(destDir, base), nodePath.basename(from))
    } catch (e: any) {
        return e?.message ?? String(e)
    }
    // The source stat comes first so that a doomed operation never bins a destination on its way
    // to failing. `?? lstat`: a DANGLING symlink is a real item that fs.cp/fs.rename can move.
    const srcStat = await statOf(from) ?? await lstatOf(from)
    // No path in the message — the panel prefixes failures with the item's own path already.
    if (!srcStat) { return 'the item no longer exists' }
    const dstStat = await statOf(to)
    if (sameEntry(srcStat, dstStat)) { return SAME_ENTRY }
    // SYMMETRIC, and it has to be. `to` inside `from` is a folder copied into its own subfolder,
    // which fs.cp at least refuses on its own (ERR_FS_CP_EINVAL). `from` inside `to` is the mirror
    // — flattening `…/src/src` into `…/`, where `to` is `…/src`, an ANCESTOR of the source — and
    // there raw fs.cp SUCCEEDS, so nothing downstream would ever catch it: the destination we were
    // about to bin contains the source. The shape this must NOT refuse is the ordinary move up one
    // level — into the parent of the directory the item sits in, where `to` lands beside that
    // directory, nested neither way. (Into the directory it ALREADY sits in, `to` === `from`: a
    // no-op, refused upstream as SAME_ENTRY.)
    if (await nests(from, srcStat, to) || await nests(to, dstStat, from)) { return OVERLAP }
    return { from, to }
}

/** Why a copy/move of `src` into `destDir` cannot proceed, or null. */
export async function localRefusal (src: string, destDir: string, base = ''): Promise<string | null> {
    const ends = await endpoints(src, destDir, base)
    return typeof ends === 'string' ? ends : null
}

/** "Overwrite" means REPLACE, for both files and directories and for both copy and move:
 *  fs.rename cannot replace a non-empty directory at all (EPERM/ENOTEMPTY) and fs.cp merges
 *  into one, so the destination goes first once the user has consented.
 *  Without a base, via the RECYCLE BIN, like `localTrash`: consenting to "Overwrite" is not
 *  consent to a permanent delete, and the panel never hard-deletes on an ordinary local tab.
 *  A failing bin is reported, never quietly downgraded to `fs.rm`.
 *  WITH a base it is permanent, because a WSL share has no recycle bin to route through —
 *  `shell.trashItem` on \\wsl$ fails, or worse deletes permanently anyway. The panel says so in
 *  the overwrite prompt BEFORE this runs, so the consent is still informed. A second base kind
 *  that does have a bin would need this coupling split into its own flag; today base implies WSL.
 *  Returns whether anything was actually removed: the window between the collision check and
 *  here contains a MODAL DIALOG — a user who resolves the conflict by deleting the destination
 *  in their file manager and then clicks Overwrite must get a successful copy, not ENOENT.
 *  Only ENOENT counts as "already gone": any other stat failure (EACCES on the parent, say) is
 *  reported, because treating it as cleared would silently downgrade the overwrite the user asked
 *  for into an fs.cp MERGE. */
async function clearDestination (to: string, base: string): Promise<boolean> {
    try {
        await fsp.stat(to)
    } catch (e: any) {
        if (e?.code === 'ENOENT') { return false }
        throw e
    }
    if (base) {
        await fsp.rm(to, { recursive: true, force: true })
    } else {
        await req('electron').shell.trashItem(to)
    }
    return true
}

/** The destination is removed BEFORE the copy/rename, so a failure there (EBUSY/EACCES on a
 *  locked file is routine on Windows, ENOSPC, a source that vanished) leaves it gone. Say so,
 *  and say WHICH — on an ordinary local tab the item is in the recycle bin and recoverable, on a
 *  WSL share it is not, and the user cannot tell from a raw errno. */
function afterClear (msg: string, cleared: boolean, base: string): string {
    if (!cleared) { return msg }
    return base
        ? `${msg}; the existing destination had already been deleted permanently`
        : `${msg}; the existing destination had already been moved to the recycle bin`
}

/** Remove the destination when the user consented, or the message to report. `{ cleared }` says
 *  whether anything actually went away, which is what the failure wording keys off. */
async function clear (to: string, overwrite: boolean, base: string): Promise<{ cleared: boolean } | string> {
    if (!overwrite) { return { cleared: false } }
    try {
        return { cleared: await clearDestination(to, base) }
    } catch (e: any) {
        return base
            ? `could not delete the existing destination: ${e?.message ?? String(e)}`
            : `could not move the existing destination to the recycle bin: ${e?.message ?? String(e)}`
    }
}

/** Recursive copy of `src` INTO the directory `destDir`, keeping its basename.
 *  `overwrite` (the user said so at the collision prompt) replaces the destination entry. */
export async function localCopy (src: string, destDir: string, overwrite = false, base = ''): Promise<string | null> {
    const ends = await endpoints(src, destDir, base)
    if (typeof ends === 'string') { return ends }
    const cleared = await clear(ends.to, overwrite, base)
    if (typeof cleared === 'string') { return cleared }
    try {
        // Without consent, never clobber: the panel only gets here when the destination did
        // not exist a moment ago, so anything present now appeared behind the user's back.
        await fsp.cp(ends.from, ends.to, { recursive: true, errorOnExist: !overwrite, force: overwrite })
        return null
    } catch (e: any) {
        return afterClear(e?.message ?? String(e), cleared.cleared, base)
    }
}

/** Move `src` INTO the directory `destDir`. Falls back to copy-then-delete across volumes,
 *  where rename fails with EXDEV. */
export async function localMove (src: string, destDir: string, overwrite = false, base = ''): Promise<string | null> {
    const ends = await endpoints(src, destDir, base)
    if (typeof ends === 'string') { return ends }
    const cleared = await clear(ends.to, overwrite, base)
    if (typeof cleared === 'string') { return cleared }
    try {
        await fsp.rename(ends.from, ends.to)
        return null
    } catch (e: any) {
        if (e?.code !== 'EXDEV') { return afterClear(e?.message ?? String(e), cleared.cleared, base) }
        // The destination is already in the bin when overwrite was consented to, so the copy leg
        // must NOT be asked to overwrite again — there is nothing left to clear, and asking
        // trashItem to bin a path that no longer exists would fail the move outright.
        const copyErr = await localCopy(src, destDir, false, base)
        // Same wording as every other leg: a partial copy is not the only thing the user needs to
        // know — their original destination is in the bin, and nothing else here would say so.
        if (copyErr) {
            return afterClear(`cross-device move stopped partway through the copy; the destination may hold a partial copy: ${copyErr}`, cleared.cleared, base)
        }
        try {
            await fsp.rm(ends.from, { recursive: true, force: true })
            return null
        } catch (e2: any) {
            return `copied, but could not remove the source: ${e2?.message ?? String(e2)}`
        }
    }
}

/** Remove an item. Without a base, to the OS recycle bin: deleting a local file has no remote
 *  copy to fall back on, and the OS already owns undo. With a base it is permanent — a WSL
 *  share has no bin — which is why the panel's confirmation says so on those tabs.
 *  `electron` is required lazily so importing this module never needs it: the fs helpers stay
 *  unit-testable, and a test that does exercise a bin can stub `window.require('electron')`. */
export async function localTrash (p: string, base = ''): Promise<string | null> {
    const refused = refuseDriveRoot(p, base)
    if (refused) { return refused }
    try {
        const native = toNativeFsPath(p, base)
        if (base) {
            await fsp.rm(native, { recursive: true, force: true })
        } else {
            await req('electron').shell.trashItem(native)
        }
        return null
    } catch (e: any) {
        return e?.message ?? String(e)
    }
}
