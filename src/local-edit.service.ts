import { Injectable } from '@angular/core'
import { ConfigService, PlatformService, TranslateService, ProfilesService } from 'tabby-core'
import { Subject, debounceTime, debounce } from 'rxjs'
import { parseFtypeExe, describeSftpError, hostKey, editKey, SessionRegistry } from './sftp-util'
import { LogService } from './log.service'

const req = (window as any).require
const fs = req('fs'), os = req('os'), nodePath = req('path')

export type Opener = (tempPath: string) => void | Promise<void>

// One file checked out for local editing. Keyed by editKey(hostKey, remotePath), so the
// same file on the same server is ONE temp copy no matter how often or from how many tabs
// it gets opened.
interface OpenEdit {
  key: string
  hostKey: string
  remotePath: string
  name: string
  tempDir: string
  tempPath: string
  mode: number    // remote mode, re-applied after every upload
  mtime: number   // remote mtime (ms) as of the last transfer WE made — the baseline a
                  // conflict is measured against. 0 = unknown, which disables the check.
  watcher: any | null
  ready: boolean  // false while the first download is still in flight — a re-click during
                  // that window must not treat the record as usable yet.
}

@Injectable({ providedIn: 'root' })
export class LocalEditService {
  // Files currently checked out for editing. The temp dirs are wiped when Tabby's window
  // unloads, so quitting leaves no downloaded copies behind — and an editor still holding
  // one gets the "file no longer exists" prompt instead of silently saving into the void.
  private openEdits = new Map<string, OpenEdit>()
  // Live SFTP handles per server. A save picks one from here, so closing the tab that
  // opened a file does not orphan it while another tab to the same server is still up.
  private sessions = new SessionRegistry()
  private hostKeys = new WeakMap<any, string>()
  private hostProfiles = new Map<string, any>()   // hostKey → SSHProfile, for reconnect offers
  private fallbackSeq = 0

  constructor (
    private config: ConfigService,
    private platform: PlatformService,
    private translate: TranslateService,
    private log: LogService,
    private profilesService: ProfilesService,
  ) {
    // beforeunload fires on quit and on reload alike, and rmSync is synchronous, so the
    // deletes complete before the window goes away. A hard kill still leaks — OS temp sweep.
    window.addEventListener('beforeunload', () => {
      for (const edit of [...this.openEdits.values()]) { this.rmTemp(edit) }
    })
  }

  private rmTemp (edit: OpenEdit): void {
    edit.watcher?.close()
    edit.watcher = null
    this.openEdits.delete(edit.key)
    try { fs.rmSync(edit.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  // Called by the panel once its SFTP handle is up. `profile` is the SSHSession's profile
  // (public in tabby-ssh, absent from our structural typing) — without it we fall back to a
  // per-handle id, which degrades dedup to per-session rather than merging unrelated servers.
  registerSession (sftp: any, profile: any): void {
    if (this.hostKeys.has(sftp)) { return }
    const key = hostKey(profile) || `session-${++this.fallbackSeq}`
    this.hostKeys.set(sftp, key)
    this.sessions.add(key, sftp)
    if (profile) { this.hostProfiles.set(key, profile) }
    sftp.closed$?.subscribe(() => this.unregisterSession(sftp))
  }

  // A handle going away no longer ends the edit: the temp copy, the watcher and the record
  // all survive, so a save after the tab (or the connection) is gone can offer to reconnect.
  // Only window unload deletes temp copies.
  unregisterSession (sftp: any): void {
    const key = this.hostKeys.get(sftp)
    if (!key) { return }
    this.hostKeys.delete(sftp)
    this.sessions.remove(key, sftp)
  }

  private keyFor (sftp: any): string {
    if (!this.hostKeys.has(sftp)) { this.registerSession(sftp, null) }
    return this.hostKeys.get(sftp)!
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
    const host = this.keyFor(sftp)
    const key = editKey(host, item.fullPath)

    const existing = this.openEdits.get(key)
    if (existing && await this.reopen(existing, opener)) { return }

    const tempDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'sftp-panel-'))  // stdlib mkdtemp, no tmp-promise dep
    const tempPath = nodePath.join(tempDir, item.name)

    // The panel's listing can be minutes old. Re-read the metadata so the transfer's declared
    // size is the real one — FileTransfer.isComplete() is `completedBytes >= getSize()`, so a
    // stale size makes the download report complete early or never complete at all. The same
    // read supplies the mtime baseline the conflict check measures against.
    const start = await this.freshMeta(sftp, item.fullPath)
    if (start) { mode = start.mode; size = start.size }
    const edit: OpenEdit = {
      key, hostKey: host, remotePath: item.fullPath, name: item.name,
      tempDir, tempPath, mode, mtime: +(start?.modified ?? 0), watcher: null, ready: false,
    }
    this.openEdits.set(key, edit)

    try {
      const transfer = await (this.platform as any).startDownload(item.name, mode, size, tempPath)
      if (!transfer) { this.rmTemp(edit); return }
      await sftp.download(item.fullPath, transfer)
      await opener(tempPath)
      edit.ready = true
    } catch (e) {
      this.rmTemp(edit)
      throw e
    }

    fs.chmodSync(tempPath, 0o700)
    // Skip the download's own write burst before watching.
    setTimeout(() => this.startWatching(edit), 1000)
  }

  // Watch the temp file and re-upload on save. Split out of edit() because a reload
  // (Task 3) has to tear the watcher down and build a fresh one on the same path.
  private startWatching (edit: OpenEdit): void {
    if (!this.openEdits.has(edit.key)) { return }   // cleaned up while we waited
    edit.watcher?.close()                            // never stack two watchers on one file
    const events = new Subject<string>()
    const watcher = fs.watch(edit.tempPath, (ev: string) => events.next(ev))
    edit.watcher = watcher
    events.pipe(debounceTime(1000), debounce(async (ev: string) => {
      if (ev === 'rename') { watcher.close() }
      await this.save(edit)
    })).subscribe()
    watcher.on('close', () => { edit.watcher = null; events.complete() })
  }

  // Push the temp file back to the server. The handle is resolved HERE, not captured when
  // the watcher was created, so the save still works after the opening tab is closed.
  private async save (edit: OpenEdit): Promise<void> {
    if (!this.openEdits.has(edit.key)) { return }   // cleaned up while the save was debouncing
    try {
      const sftp = this.sessions.any(edit.hostKey) ?? await this.reconnect(edit)
      if (!sftp || !this.openEdits.has(edit.key)) { return }
      if (!await this.confirmNoConflict(sftp, edit)) { return }
      const upload = await (this.platform as any).startUpload({ multiple: false }, [edit.tempPath])
      if (!upload.length) { return }
      await sftp.upload(edit.remotePath, upload[0])
      await sftp.chmod(edit.remotePath, edit.mode)
      // Our own write moved the remote mtime — rebase the baseline on it, or the very
      // next save would report a conflict against ourselves.
      edit.mtime = +((await this.freshMeta(sftp, edit.remotePath))?.modified ?? 0)
    } catch (e: any) {
      this.reportUploadFailure(edit.name, edit.tempPath, e)
    }
  }

  // No live connection to the file's server. The edit is still valid — its temp copy and
  // watcher outlive the tab — so offer to bring the server back rather than failing the save.
  // Opening a real tab reuses Tabby's whole auth flow (passwords, key prompts, known-hosts);
  // that tab's panel registers its SFTP handle with us as soon as it is up, which is what we
  // wait for. Returns null when the user declines or the connection never arrives.
  private async reconnect (edit: OpenEdit): Promise<any | null> {
    const profile = this.hostProfiles.get(edit.hostKey)
    if (!profile) { throw new Error(this.translate.instant('No open connection to {host}', { host: edit.hostKey })) }

    const r = await this.platform.showMessageBox({
      type: 'warning',
      message: this.translate.instant('No open connection to {host}', { host: edit.hostKey }),
      detail: this.translate.instant('Open a new tab to save {name}?', { name: edit.name }),
      buttons: [this.translate.instant('Reconnect and save'), this.translate.instant('Cancel')],
      defaultId: 0, cancelId: 1,
    })
    if (r.response !== 0) {
      this.log.log('warn', this.translate.instant('Upload cancelled: {name}', { name: edit.name }))
      return null
    }

    await this.profilesService.openNewTabForProfile(profile)
    // No event marks "SFTP ready" — the new panel registers itself, so poll for it. 60s covers
    // an interactive password/2FA prompt in the new tab.
    for (let i = 0; i < 120 && !this.sessions.any(edit.hostKey); i++) {
      await new Promise(res => setTimeout(res, 500))
    }
    const sftp = this.sessions.any(edit.hostKey)
    if (!sftp) { throw new Error(this.translate.instant('No open connection to {host}', { host: edit.hostKey })) }
    return sftp
  }

  // Already checked out: no download, no second temp copy — just point the editor at the file
  // we have. Returns false when the record turned out to be unusable and the caller should
  // download afresh.
  private async reopen (edit: OpenEdit, opener: Opener): Promise<boolean> {
    if (!edit.ready) { return true }               // first download still running — ignore the re-click
    if (!fs.existsSync(edit.tempPath)) {           // moved away by an atomic-save editor, or swept
      this.rmTemp(edit)
      return false
    }
    const sftp = this.sessions.any(edit.hostKey)
    const remote = sftp ? await this.freshMeta(sftp, edit.remotePath) : null
    let reloaded = false
    if (remote && edit.mtime && +remote.modified > edit.mtime) {
      const r = await this.platform.showMessageBox({
        type: 'warning',
        message: this.translate.instant('{name} changed on the server since you opened it', { name: edit.name }),
        detail: this.translate.instant('Reloading replaces the local copy and discards unsaved editor changes.'),
        buttons: [this.translate.instant('Reload from server'), this.translate.instant('Keep the local copy')],
        defaultId: 1, cancelId: 1,
      })
      if (r.response === 0) { await this.reload(sftp, edit, remote); reloaded = true }
    }
    // reload() owns restarting the watcher on its own 1s-delayed timer (to skip its download's
    // write burst) — only revive here when reload did NOT run, e.g. a watcher an atomic-save
    // editor closed on its own.
    if (!reloaded && !edit.watcher) { this.startWatching(edit) }
    // Runs in both branches: for an editor that is still open this only raises its window.
    await opener(edit.tempPath)
    return true
  }

  // Re-download into a .part sibling to avoid corrupting the real temp file if the download
  // fails. The watcher is closed first and rebuilt afterwards: our own write would otherwise
  // bounce straight back as an upload, and a download that replaces the file rather than
  // truncating it would leave the old watcher on an unlinked inode. startDownload opens the
  // destination with 'w' mode, truncating it immediately, so if the download then fails, the
  // file is already lost — we use the .part file to keep the original safe.
  private async reload (sftp: any, edit: OpenEdit, remote: any): Promise<void> {
    edit.watcher?.close()
    edit.watcher = null
    try {
      const partPath = edit.tempPath + '.part'
      const transfer = await (this.platform as any).startDownload(edit.name, remote.mode, remote.size, partPath)
      if (transfer) {
        await sftp.download(edit.remotePath, transfer)
        fs.renameSync(partPath, edit.tempPath)
        edit.mode = remote.mode
        edit.mtime = +remote.modified
        fs.chmodSync(edit.tempPath, 0o700)
      } else {
        this.log.log('warn', this.translate.instant('Could not open {name}', { name: edit.name }))
      }
    } catch (e: any) {
      // Clean up the part file if the download failed, leaving the original temp copy
      // and baseline untouched — the user still has their local copy and their editor.
      try { fs.rmSync(edit.tempPath + '.part', { force: true }) } catch { /* ignore */ }
      this.log.log('error', this.translate.instant('Could not open {name}', { name: edit.name }), describeSftpError(e))
    } finally {
      setTimeout(() => this.startWatching(edit), 1000)   // skip our own write burst
    }
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
