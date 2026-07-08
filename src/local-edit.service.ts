import { Injectable } from '@angular/core'
import { ConfigService, PlatformService } from 'tabby-core'
import { Subject, debounceTime, debounce } from 'rxjs'
import { parseFtypeExe } from './sftp-util'
import { LogService } from './log.service'

const req = (window as any).require
const fs = req('fs'), os = req('os'), nodePath = req('path')

export type Opener = (tempPath: string) => void | Promise<void>

@Injectable({ providedIn: 'root' })
export class LocalEditService {
  constructor (private config: ConfigService, private platform: PlatformService, private log: LogService) {}

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
    const cleanup = () => { try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ } }

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
          const upload = await (this.platform as any).startUpload({ multiple: false }, [tempPath])
          if (!upload.length) { return }
          await sftp.upload(item.fullPath, upload[0])
          await sftp.chmod(item.fullPath, mode)
        } catch (e: any) {
          this.log.log('error', `Re-upload failed: ${item.name}`, e?.message)
        }
      })).subscribe()
      watcher.on('close', () => events.complete())
      sftp.closed$.subscribe(() => { watcher.close(); cleanup() })
    }, 1000)
  }
}
