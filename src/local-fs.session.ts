import type { SFTPFile } from 'tabby-ssh'
import type { FileUpload, FileDownload } from 'tabby-core'
import { toNativeFsPath, toVirtualPath, isVirtualRoot, driveRoots, isWin } from './local-path'

// Node builtins via Electron's require — see the window.require note in AGENTS.md.
const req = (window as any).require
const fs = req('fs'), fsp = fs.promises

const CHUNK = 256 * 1024   // same read size russh's SFTPFileHandle uses

// Duck-types tabby-ssh's SFTPSession (_tabby-ref/tabby-ssh/src/session/sftp.ts) over the
// local filesystem. The panel calls exactly the eleven methods below on `this.sftp`, so
// implementing them here leaves every call site in panel.component.ts unchanged.
// All paths in and out are VIRTUAL posix paths (see local-path.ts).
export class LocalFsSession {
    async readdir (p: string): Promise<SFTPFile[]> {
        if (isVirtualRoot(p)) { return this.drives() }
        const native = toNativeFsPath(p)
        const names: string[] = await fsp.readdir(native)
        const out = await Promise.all(names.map(n => this.entry(p, n)))
        // Entries can vanish between readdir and lstat — drop them rather than fail the listing.
        return out.filter(Boolean) as SFTPFile[]
    }

    async stat (p: string): Promise<SFTPFile> {
        const native = toNativeFsPath(p)
        const st = await fsp.stat(native)          // follows symlinks, like SFTP stat
        const lst = await fsp.lstat(native).catch(() => st)
        return this.toFile(p, st, lst.isSymbolicLink())
    }

    async readlink (p: string): Promise<string> {
        const target: string = await fsp.readlink(toNativeFsPath(p))
        // Absolute targets become virtual; relative ones stay relative — the panel feeds the
        // result to posix.resolve(this.path, target), which needs that distinction intact.
        const rel = isWin ? !/^([A-Za-z]:|\\\\)/.test(target) : !target.startsWith('/')
        return rel ? target.replace(/\\/g, '/') : toVirtualPath(target)
    }

    // ponytail: the russh OPEN_* bit flags are ignored. The panel's only call is
    // openCreateFileModal() creating an empty file, so this always opens exclusively for
    // write — an existing file surfaces as EEXIST in the panel log instead of being
    // truncated, which is the safer direction for a "New file" action.
    async open (p: string, _mode: number): Promise<{ read(): Promise<Uint8Array>, write(c: Uint8Array): Promise<void>, close(): Promise<void> }> {
        const h = await fsp.open(toNativeFsPath(p), 'wx')
        return {
            async read () { return new Uint8Array(0) },
            async write (c: Uint8Array) { await h.write(c) },
            async close () { await h.close() },
        }
    }

    async mkdir (p: string): Promise<void> { await fsp.mkdir(toNativeFsPath(p)) }
    async rmdir (p: string): Promise<void> { await fsp.rmdir(toNativeFsPath(p)) }
    async unlink (p: string): Promise<void> { await fsp.unlink(toNativeFsPath(p)) }
    async rename (from: string, to: string): Promise<void> { await fsp.rename(toNativeFsPath(from), toNativeFsPath(to)) }
    async chmod (p: string, mode: string | number): Promise<void> { await fsp.chmod(toNativeFsPath(p), mode) }

    // Streaming through the same FileUpload/FileDownload interface is what keeps drag-in,
    // drag-out, the transfer log rows, the progress bars and the per-row Stop button working
    // with no panel changes at all.
    async download (p: string, transfer: FileDownload): Promise<void> {
        try {
            const h = await fsp.open(toNativeFsPath(p), 'r')
            try {
                const buf = Buffer.allocUnsafe(CHUNK)
                while (true) {
                    const { bytesRead } = await h.read(buf, 0, CHUNK, null)
                    if (!bytesRead) { break }
                    // Copy: `buf` is reused on the next iteration.
                    await transfer.write(new Uint8Array(buf.subarray(0, bytesRead)))
                }
            } finally { await h.close() }
            transfer.close()
        } catch (e) {
            transfer.cancel()
            throw e
        }
    }

    // Mirrors SFTPSession.upload: write to a sibling temp file, then swap it in, so a
    // cancelled or failed transfer never leaves a truncated destination.
    async upload (p: string, transfer: FileUpload): Promise<void> {
        const native = toNativeFsPath(p)
        const temp = native + '.tabby-upload'
        try {
            const h = await fsp.open(temp, 'w')
            try {
                while (true) {
                    const chunk = await transfer.read()
                    if (!chunk.length) { break }
                    await h.write(chunk)
                }
            } finally { await h.close() }
            await fsp.rm(native, { force: true })
            await fsp.rename(temp, native)
            transfer.close()
        } catch (e) {
            transfer.cancel()
            await fsp.rm(temp, { force: true }).catch(() => null)
            throw e
        }
    }

    private async entry (dir: string, name: string): Promise<SFTPFile | null> {
        const full = dir.replace(/\/+$/, '') + '/' + name
        try {
            // lstat, not stat: SFTP readdir does not follow symlinks either, and following
            // them here would hang on a link into a dead network mount.
            const st = await fsp.lstat(toNativeFsPath(full))
            return this.toFile(full, st, st.isSymbolicLink())
        } catch {
            return null
        }
    }

    private toFile (virtual: string, st: any, isSymlink: boolean): SFTPFile {
        const name = virtual.split('/').filter(Boolean).pop() ?? virtual
        return {
            name,
            fullPath: virtual,
            isDirectory: st.isDirectory(),
            isSymlink,
            mode: st.mode,          // already carries the file-type bits (0o100644)
            size: st.size,
            modified: st.mtime,
        }
    }

    private drives (): SFTPFile[] {
        return driveRoots(p => fs.existsSync(p)).map(v => ({
            name: v.slice(1),       // '/C:' -> 'C:'
            fullPath: v,
            isDirectory: true,
            isSymlink: false,
            mode: 0o040755,
            size: 0,
            modified: new Date(0),
        }))
    }
}
