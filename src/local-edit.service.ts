import { Injectable } from '@angular/core'
import { ConfigService, PlatformService, TranslateService } from 'tabby-core'
import { Subject, debounceTime, debounce } from 'rxjs'
import { parseFtypeExe, describeSftpError } from './sftp-util'
import { LogService } from './log.service'

const req = (window as any).require
const fs = req('fs'), os = req('os'), nodePath = req('path')

export type Opener = (tempPath: string) => void | Promise<void>

// One file checked out for local editing.
interface OpenEdit {
  remotePath: string
  name: string
  mtime: number   // remote mtime (ms) as of the last transfer WE made — the baseline a
                  // conflict is measured against. 0 = unknown, which disables the check.
}

@Injectable({ providedIn: 'root' })
export class LocalEditService {
  // Files currently checked out for editing, keyed by their temp dir. The temp dirs are wiped
  // when Tabby's window unloads, so quitting leaves no downloaded copies behind — and an
  // editor still holding one gets the "file no longer exists" prompt instead of silently
  // saving into the void.
  private openEdits = new Map<string, OpenEdit>()

  constructor (
    private config: ConfigService,
    private platform: PlatformService,
    private translate: TranslateService,
    private log: LogService,
  ) {
    // beforeunload fires on quit and on reload alike, and rmSync is synchronous, so the
    // deletes complete before the window goes away. A hard kill still leaks — OS temp sweep.
    window.addEventListener('beforeunload', () => {
      for (const dir of [...this.openEdits.keys()]) { this.rmTemp(dir) }
    })
  }

  private rmTemp (dir: string): void {
    this.openEdits.delete(dir)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  // Current metadata for one remote file, or null when it cannot be read.
  //
  // NOT SFTPSession.stat(): russh returns `size` there but leaves `permissions` and `mtime`
  // empty, so mode came back as 0 (which chmods the remote file to 0000 on re-upload) and
  // mtime as epoch 0 (which silently disables the conflict check below). readdir carries the
  // full metadata. Remote paths are always POSIX, so slice the parent off by hand rather than
  // going through node's path module, which is win32-flavoured on Windows.
  private async freshMeta (sftp: any, remotePath: string): Promise<any | null> {
    try {
      const dir = remotePath.replace(/\/[^/]*$/, '') || '/'
      const hit = (await sftp.readdir(dir)).find((e: any) => e.fullPath === remotePath)
      return !hit || hit.isSymlink ? null : hit   // a link entry describes the link, not the target
    } catch { return null }
  }

  // Launch a specific editor on the temp file (detached so closing the panel doesn't kill it).
  spawnOpener (exe: string): Opener {
    return (tempPath: string) => {
      // Expand %ENV% ourselves and spawn WITHOUT a shell, so Node quotes the args for
      // CreateProcess — a shell would split an unquoted temp path that contains spaces.
      const resolved = exe.replace(/%([^%]+)%/g, (_m, v) => process.env[v] ?? '')
      const opts = { detached: true, stdio: 'ignore', windowsHide: true }
      const cp = req('child_process')
      // macOS: a picked .app is a bundle directory, not an executable — launch it via `open -a`.
      const isMacApp = process.platform === 'darwin' && /\.app\/?$/i.test(exe)
      const child = isMacApp
        ? cp.spawn('open', ['-a', exe, tempPath], opts)
        : cp.spawn(resolved, [tempPath], opts)
      child.on('error', () => {
        // Bad editor path: tell the user and fall back to the OS default app.
        this.log.log('warn', 'Editor failed to launch, opening with default app', exe)
        this.platform.openPath(tempPath)
      })
      child.unref()
    }
  }

  // Open with the OS default app for the file's type.
  defaultOpener: Opener = (tempPath: string) => { this.platform.openPath(tempPath) }

  // Editor to use at open time: only when the feature is enabled AND a path is set; else '' (= OS default app).
  // Detection happens in settings (on toggle-on), not here — a blank path with the toggle on means "OS default".
  resolveEditor (): string {
    const cfg = this.config.store.sftpPanel
    return cfg.editorEnabled ? (cfg.editorPath || '').trim() : ''
  }

  // Windows-only auto-detect of the .txt handler, for the settings toggle to prefill the path. '' elsewhere/on failure.
  async detectDefaultEditor (): Promise<string> {
    if (process.platform !== 'win32') { return '' }   // win-only detect; manual/Browse covers other OSes
    return this.detectTxtHandler()
  }

  // Win11 keeps the real .txt default in the per-user UserChoice registry, NOT legacy assoc/ftype.
  // Read UserChoice ProgId → its shell\open\command → extract the exe. Fall back to classic notepad
  // (Store-app defaults have no plain exe to spawn, and notepad.exe is always present on Windows).
  private async detectTxtHandler (): Promise<string> {
    const { execFile } = req('child_process')
    const query = (args: string[]) => new Promise<string>(resolve => {
      execFile('reg', args, { windowsHide: true, timeout: 5000 }, (e: any, out: string) => resolve(e ? '' : String(out || '')))
    })
    // reg output line: `    ProgId    REG_SZ    Applications\notepad++.exe` — take everything after the type token.
    const regValue = (out: string) => out.match(/REG_(?:EXPAND_)?SZ\s+(.*)/)?.[1].trim() ?? ''
    const fallback = '%SystemRoot%\\system32\\notepad.exe'

    const progid = regValue(await query(['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.txt\\UserChoice', '/v', 'ProgId']))
    if (progid) {
      const cmd = regValue(await query(['query', `HKCR\\${progid}\\shell\\open\\command`, '/ve']))
      const exe = parseFtypeExe(cmd ? `=${cmd}` : '')   // reuse the ftype parser: prepend '=' so it reads the RHS
      const resolved = exe.replace(/%([^%]+)%/g, (_m, v) => process.env[v] ?? '')
      if (exe && /\.exe$/i.test(resolved) && fs.existsSync(resolved)) { return exe }
    }
    return fallback
  }

  // Download item to a temp file, run `opener` on it, then watch for saves and re-upload.
  // Mirrors Tabby's built-in EditSFTPContextMenu.edit(), parametrized by `opener`.
  async edit (sftp: any, item: any, mode: number, size: number, opener: Opener): Promise<void> {
    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sftp-panel-'))  // stdlib mkdtemp, no tmp-promise dep
    const tempPath = nodePath.join(tempDir, item.name)
    const cleanup = () => this.rmTemp(tempDir)

    // The panel's listing can be minutes old. Re-read the metadata so the transfer's declared
    // size is the real one — FileTransfer.isComplete() is `completedBytes >= getSize()`, so a
    // stale size makes the download report complete early or never complete at all. The same
    // read supplies the mtime baseline the conflict check below measures against.
    const start = await this.freshMeta(sftp, item.fullPath)
    if (start) { mode = start.mode; size = start.size }
    const edit: OpenEdit = { remotePath: item.fullPath, name: item.name, mtime: +(start?.modified ?? 0) }
    this.openEdits.set(tempDir, edit)

    try {
      const transfer = await (this.platform as any).startDownload(item.name, mode, size, tempPath)
      if (!transfer) { cleanup(); return }
      await sftp.download(item.fullPath, transfer)
      await opener(tempPath)
    } catch (e) {
      cleanup()
      throw e
    }

    const events = new Subject<string>()
    fs.chmodSync(tempPath, 0o700)
    // Skip the download's own write burst before watching.
    setTimeout(() => {
      const watcher = fs.watch(tempPath, (ev: string) => events.next(ev))
      events.pipe(debounceTime(1000), debounce(async (ev: string) => {
        try {
          if (ev === 'rename') { watcher.close() }
          if (!await this.confirmNoConflict(sftp, edit)) { return }
          const upload = await (this.platform as any).startUpload({ multiple: false }, [tempPath])
          if (!upload.length) { return }
          await sftp.upload(item.fullPath, upload[0])
          await sftp.chmod(item.fullPath, mode)
          // Our own write moved the remote mtime — rebase the baseline on it, or the very
          // next save would report a conflict against ourselves.
          edit.mtime = +((await this.freshMeta(sftp, item.fullPath))?.modified ?? 0)
        } catch (e: any) {
          this.reportUploadFailure(item.name, tempPath, e)
        }
      })).subscribe()
      watcher.on('close', () => events.complete())
      sftp.closed$.subscribe(() => { watcher.close(); cleanup() })
    }, 1000)
  }

  // Someone else touched the file on the server since we last transferred it? Ask before
  // overwriting their version. Returns false when the user backs out.
  private async confirmNoConflict (sftp: any, edit: OpenEdit): Promise<boolean> {
    if (!edit.mtime) { return true }   // no baseline (the initial read failed) — nothing to compare
    const remote = await this.freshMeta(sftp, edit.remotePath)
    if (!remote || +remote.modified <= edit.mtime) { return true }

    const r = await this.platform.showMessageBox({
      type: 'warning',
      message: this.translate.instant('{name} changed on the server since you opened it', { name: edit.name }),
      detail: this.translate.instant('Uploading now replaces the newer version on the server.'),
      buttons: [this.translate.instant('Upload anyway'), this.translate.instant('Cancel')],
      defaultId: 1, cancelId: 1,
    })
    if (r.response === 0) { return true }
    // Declining leaves the local copy untouched, so a later save can still go through.
    this.log.log('warn', this.translate.instant('Upload cancelled: {name}', { name: edit.name }))
    return false
  }

  // A failed re-upload means the user's edits exist ONLY in the temp file, and they may well
  // close the editor believing the save landed. A log line alone gets missed (issue #4), so
  // this is a modal — and it names the temp path so the changes can be recovered by hand.
  private reportUploadFailure (name: string, tempPath: string, e: any): void {
    const message = this.translate.instant('Could not save {name} to the server', { name })
    const reason = describeSftpError(e)   // raw russh errors are a Rust debug dump, unreadable
    this.log.log('error', message, reason)
    this.platform.showMessageBox({
      type: 'error',
      message,
      detail: [reason, this.translate.instant('Your changes are still in the local copy at {path}', { path: tempPath })]
        .filter(Boolean).join('\n\n'),
      buttons: [this.translate.instant('Close')],
    })
  }
}
