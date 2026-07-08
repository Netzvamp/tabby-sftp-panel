import { Injectable } from '@angular/core'
import { Subject, Observable } from 'rxjs'
import { PlatformService, ConfigService, FileTransfer, FileUpload } from 'tabby-core'
import { LogEntry, LogLevel, logFullText } from './sftp-util'

// Unified panel log: file transfers (fed by Tabby's platform stream) plus messages
// (chmod failures, other panel info/errors). Shared by every panel. Tabby mutates its
// own transfer list outside Angular's zone, so panels subscribe to changed$ and force
// detectChanges — that explicit CD beats the 10-20s background lag.
@Injectable({ providedIn: 'root' })
export class LogService {
    entries: LogEntry[] = []
    get changed$ (): Observable<void> { return this.changed }
    private changed = new Subject<void>()
    private timer: any = null
    private seq = 0
    // While capturing, incoming platform transfers are stashed instead of shown — a
    // folder upload/drag emits one row PER descendant file during discovery (getAllFiles /
    // traverseFileTree next() every file). The panel captures across discovery, discards
    // the stash, and renders one aggregate row instead of a flash of per-file rows.
    private capturing = false
    private captured: FileTransfer[] = []
    private scanEntry: LogEntry | null = null
    // Show ONE live "Scanning folder…" row while capturing so a big-folder scan isn't a
    // silent freeze; its count ticks up as files stream in. The panel swaps it for the
    // aggregate row (endScan) once discovery + collision checks are done.
    beginCapture (): void {
        this.capturing = true; this.captured = []
        this.scanEntry = this.log('info', 'Scanning folder…')
    }
    endCapture (): FileTransfer[] { this.capturing = false; const c = this.captured; this.captured = []; return c }
    setScanText (text: string): void { if (this.scanEntry) { this.update(this.scanEntry, text) } }
    endScan (): void { if (this.scanEntry) { this.remove(this.scanEntry); this.scanEntry = null } }

    constructor (private platform: PlatformService, private config: ConfigService) {
        this.platform.fileTransferStarted$.subscribe(t => this.add(t))
        // We own the transfer UI — hide Tabby's toolbar transfers button + its
        // (body-teleported) dropdown so a transfer never pops Tabby's own panel.
        this.ensureHideStyle()
        document.body.classList.add('sftp-panel-hide-tabby-transfers')
    }

    private ensureHideStyle (): void {
        if (document.getElementById('sftp-panel-hide-tabby')) { return }
        const el = document.createElement('style')
        el.id = 'sftp-panel-hide-tabby'
        el.textContent = `
          body.sftp-panel-hide-tabby-transfers transfers-menu,
          body.sftp-panel-hide-tabby-transfers button.btn-tab-bar.dropdown-toggle { display: none !important; }
        `
        document.head.appendChild(el)
    }

    private add (transfer: FileTransfer): void {
        if (this.capturing) {
            this.captured.push(transfer)
            // Repaint every 20th file — a huge tree would otherwise fire one CD per file.
            const n = this.captured.length
            if (n === 1 || n % 20 === 0) { this.setScanText(`Scanning folder… (${n} files)`) }
            return
        }
        this.push({
            id: ++this.seq,
            time: new Date(),
            kind: 'transfer',
            level: 'info',
            text: transfer.getName(),
            transfer,
            isUpload: transfer instanceof FileUpload,
            size: transfer.getSize(),
        })
        this.ensurePolling()
    }

    // Fold N child transfers into one aggregate row: drop the auto-added child rows
    // WITHOUT cancelling them (they still upload), then addTransfer() the aggregate.
    dropTransfers (transfers: FileTransfer[]): void {
        const set = new Set(transfers)
        this.entries = this.entries.filter(x => !(x.transfer && set.has(x.transfer)))
        this.changed.next()
    }

    // Manually add a transfer we own (e.g. a folder-upload aggregate). Returns the
    // entry so the caller can update() its label as files progress.
    addTransfer (transfer: FileTransfer, isUpload: boolean): LogEntry {
        const entry: LogEntry = {
            id: ++this.seq, time: new Date(), kind: 'transfer', level: 'info',
            text: transfer.getName(), transfer, isUpload, size: transfer.getSize(),
        }
        this.push(entry)
        this.ensurePolling()
        return entry
    }

    // Repoint a row from a just-added platform transfer to a cancellable proxy so
    // the Stop button actually aborts it (keeps the row's id/text/size).
    swapTransfer (oldT: FileTransfer, newT: FileTransfer): void {
        const e = this.entries.find(x => x.transfer === oldT)
        if (e) { e.transfer = newT; this.changed.next(); return }
        // No existing row (the original was captured+discarded, e.g. loose files dropped
        // alongside a folder) — create one for the proxy so its progress still shows.
        this.addTransfer(newT, newT instanceof FileUpload)
    }

    // Stop an in-flight transfer (log-line Stop button). Cancel closes the handle;
    // our proxies' read()/write() then throw so the tabby-ssh loop bails out.
    stop (entry: LogEntry): void {
        const t = entry.transfer
        if (t && !t.isComplete() && !t.isCancelled()) { t.cancel() }
        this.changed.next()
    }

    // Append a message (chmod failure, panel error/notice, etc.). Returns the
    // entry so long-running operations can update() it in place.
    log (level: LogLevel, text: string, detail?: string): LogEntry {
        const entry: LogEntry = { id: ++this.seq, time: new Date(), kind: 'message', level, text, detail }
        this.push(entry)
        return entry
    }

    // Live-update an existing entry (e.g. a running delete counter).
    update (entry: LogEntry, text: string): void {
        entry.text = text
        this.changed.next()
    }

    private push (entry: LogEntry): void {
        this.entries.unshift(entry)
        if (this.entries.length > 100) { this.entries.length = 100 }
        // Any entry (incl. Tabby's built-in edit-locally re-upload, which bypasses our
        // own upload/download methods) reveals the section when auto-show is on.
        const s = this.config.store.sftpPanel
        if (s.transfersAutoShow && !s.transfersVisible) {
            s.transfersVisible = true
            this.config.save()
        }
        this.changed.next()
    }

    fullText (e: LogEntry): string { return logFullText(e) }

    // Transfer completion isn't pushed to us, so sample it. Poll only while a transfer
    // is active; each tick emits changed$ so panels re-render.
    private ensurePolling (): void {
        if (this.timer) { return }
        this.timer = setInterval(() => {
            this.changed.next()
            if (!this.hasActive()) {
                clearInterval(this.timer)
                this.timer = null
            }
        }, 300)
    }

    hasActive (): boolean {
        return this.entries.some(e => e.transfer && !e.transfer.isComplete() && !e.transfer.isCancelled())
    }

    setRemotePath (transfer: FileTransfer, absPath: string): void {
        const e = this.entries.find(x => x.transfer === transfer)
        if (e) { e.remotePath = absPath; this.changed.next() }
    }

    remove (entry: LogEntry): void {
        if (entry.transfer && !entry.transfer.isComplete()) { entry.transfer.cancel() }
        this.entries = this.entries.filter(x => x !== entry)
        this.changed.next()
    }

    clearAll (): void {
        for (const e of [...this.entries]) { this.remove(e) }
    }
}
