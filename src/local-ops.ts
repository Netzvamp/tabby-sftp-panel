import { toNativePath } from './local-path'

const req = (window as any).require
const fs = req('fs'), fsp = fs.promises, nodePath = req('path')

// The three operations the panel does differently on a local tab. Each takes VIRTUAL paths
// and returns null on success or a message on failure, so the panel can log uniformly
// without a try/catch per call site.

/** Whether `destDir` already holds an entry named `name` — the collision check the panel
 *  runs before a local copy/move, since fs.cp/fs.rename overwrite silently and there is no
 *  server-side fallback to recover a clobbered local file from. */
export async function localExists (destDir: string, name: string): Promise<boolean> {
    try {
        await fsp.stat(nodePath.join(toNativePath(destDir), name))
        return true
    } catch {
        return false
    }
}

/** Recursive copy of `src` INTO the directory `destDir`, keeping its basename. */
export async function localCopy (src: string, destDir: string): Promise<string | null> {
    const from = toNativePath(src)
    const to = nodePath.join(toNativePath(destDir), nodePath.basename(from))
    try {
        await fsp.cp(from, to, { recursive: true, errorOnExist: false, force: true })
        return null
    } catch (e: any) {
        return e?.message ?? String(e)
    }
}

/** Move `src` INTO the directory `destDir`. Falls back to copy-then-delete across volumes,
 *  where rename fails with EXDEV. */
export async function localMove (src: string, destDir: string): Promise<string | null> {
    const from = toNativePath(src)
    const to = nodePath.join(toNativePath(destDir), nodePath.basename(from))
    try {
        await fsp.rename(from, to)
        return null
    } catch (e: any) {
        if (e?.code !== 'EXDEV') { return e?.message ?? String(e) }
        const copyErr = await localCopy(src, destDir)
        if (copyErr) { return `cross-device move stopped partway through the copy; the destination may hold a partial copy: ${copyErr}` }
        try {
            await fsp.rm(from, { recursive: true, force: true })
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
    try {
        await req('electron').shell.trashItem(toNativePath(p))
        return null
    } catch (e: any) {
        return e?.message ?? String(e)
    }
}
