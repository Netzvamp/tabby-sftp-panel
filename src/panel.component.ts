import { posix as path } from 'path'
import { Component, Input, Output, EventEmitter, Injector, ChangeDetectorRef, ElementRef, HostListener, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    AppService, ConfigService, PlatformService, TranslateService,
    FileUpload, FileDownload, DirectoryUpload, MenuItemOptions, PromptModalComponent,
    // DirectoryDownload is a real runtime class (tabby-core dist/index.js) but is not re-exported
    // from tabby-core's shipped .d.ts typings, so it can't be imported as a type here — see the
    // `any` usage below and the "Exports gotcha" note in project memory.
} from 'tabby-core'
import type { SFTPSession, SFTPFile } from 'tabby-ssh'
import { SFTPContextMenuItemProvider } from 'tabby-ssh'
import { getIcon, getModeString, sortFiles, filterFiles, formatSize, formatTransferTime, computeLogSelection, SortColumn, SortDir, LogEntry, startNeedsHome, resolveStartPath, parseLsOwners, PanelFile, moveColumn, expandDirs, isBigFile, parseNames, shQuote, buildCpCommand, folderEntryFromParent, describeSftpError } from './sftp-util'
import { clampSize } from './logic'
import { LogService } from './log.service'
import { ChmodDialogComponent } from './chmod-dialog.component'
import { CopyMoveDialogComponent } from './copy-move-dialog.component'
import { LocalEditService } from './local-edit.service'

type Col = 'name' | 'size' | 'modified' | 'owner' | 'group' | 'perms'
// Thrown to unwind a cancelled recursive scan cleanly out of the (recursive) descendant walk.
const CANCELLED = Symbol('sftp-cancelled')
// SSHSession is a real class in tabby-ssh (session/ssh.d.ts, with `openSFTP(): Promise<SFTPSession>`
// matching this component's usage) but it is not re-exported from tabby-ssh's public typings
// entrypoint, so it can't be imported by name. Only the one method actually used is declared here.
// `willDestroy$` fires when the connection's SSHSession is torn down (session/ssh.d.ts).
// Structural type (no rxjs import) — we only ever `.subscribe(fn).unsubscribe()`.
interface SSHSessionLike {
    openSFTP(): Promise<SFTPSession>
    willDestroy$?: { subscribe(fn: () => void): { unsubscribe(): void } }
}
// The terminal-side SSHShellSession (tab.session): its `shell` is set once the
// shell channel is open (session/shell.d.ts). Distinct from the connection
// SSHSession above — the connection's own `shell` field is never assigned.
interface ShellSessionLike { shell?: unknown }

// Drag-out download target: writes to a local temp file. Extends tabby-core's
// FileDownload (webpack-external → same class identity as Tabby's runtime), so
// emitting it on fileTransferStarted$ makes it show up in the panel log with
// progress, speed and cancel like any platform transfer.
class DragOutDownload extends FileDownload {
    private fd: number
    // onChunk lets a folder drag-out forward per-file progress to its aggregate
    // log entry (and abort the tree by throwing when that entry is cancelled).
    constructor (private fs: any, localPath: string, private name: string, private mode: number, private size: number, private onChunk?: (bytes: number) => void) {
        super()
        this.fd = fs.openSync(localPath, 'w')
    }
    getName (): string { return this.name }
    getMode (): number { return this.mode }
    getSize (): number { return this.size }
    async write (buffer: Uint8Array): Promise<void> {
        if (this.isCancelled()) { throw new Error('Cancelled') }
        this.onChunk?.(buffer.length)
        this.fs.writeSync(this.fd, buffer)
        this.increaseProgress(buffer.length)
    }
    close (): void { try { this.fs.closeSync(this.fd) } catch { /* already closed */ } }
}

// Aggregate log entry for a whole-folder drag-out: the tree's files stream through
// per-file DragOutDownloads that bump() this one, so the log shows a single
// progressing transfer for the folder.
class FolderDragOutDownload extends FileDownload {
    private total = 0
    constructor (private name: string) { super() }
    setTotal (bytes: number): void { this.total = bytes }
    getName (): string { return this.name }
    getMode (): number { return 0o755 }
    getSize (): number { return this.total }
    bump (bytes: number): void {
        if (this.isCancelled()) { throw new Error('Cancelled') }
        this.increaseProgress(bytes)
    }
    // Files may have shrunk since the size pass — snap total to what actually
    // arrived so isComplete() turns true and the spinner stops.
    finish (): void { this.total = this.getCompletedBytes() }
    async write (_buffer: Uint8Array): Promise<void> { /* progress-only entry */ }
    close (): void { /* nothing to close */ }
}

// Aggregate log entry for a whole-folder UPLOAD: every child file streams through a
// ChildUpload that bump()s this one, so the log shows ONE progressing row (bar +
// current filename) instead of a line per file. Mirror of FolderDragOutDownload.
class FolderUpload extends FileUpload {
    private total = 0
    private current = ''
    constructor (private folder: string) { super() }
    setTotal (bytes: number): void { this.total = bytes }
    setCurrent (name: string): void { this.current = name }
    label (): string { return this.current ? `${this.folder} — ${this.current}` : this.folder }
    getName (): string { return this.folder }
    getMode (): number { return 0o644 }
    getSize (): number { return this.total }
    bump (bytes: number): void {
        if (this.isCancelled()) { throw new Error('Cancelled') }
        this.increaseProgress(bytes)
    }
    // Files may have shrunk since the size pass — snap total to what actually
    // arrived so isComplete() turns true and the spinner stops.
    finish (): void { this.total = this.getCompletedBytes() }
    async read (): Promise<Uint8Array> { return new Uint8Array(0) /* never streamed directly */ }
    close (): void { /* nothing to close */ }
}

// Wraps one real child upload so its byte stream also advances the folder aggregate
// (and aborts the whole tree when the aggregate row is cancelled — bump() throws).
class ChildUpload extends FileUpload {
    constructor (private child: FileUpload, private agg: FolderUpload) { super() }
    getName (): string { return this.child.getName() }
    getMode (): number { return this.child.getMode() }
    getSize (): number { return this.child.getSize() }
    async read (): Promise<Uint8Array> {
        const chunk = await this.child.read()
        if (chunk.length) { this.agg.bump(chunk.length) }
        return chunk
    }
    close (): void { this.child.close() }
}

// Wrap a single-file platform upload/download so the log's Stop button actually
// aborts it: tabby-ssh's upload/download loops have NO cancel checkpoint, so cancel()
// alone would run to EOF. Our read()/write() throws once cancelled, and mirrors the
// byte progress onto ourselves so the row's bar tracks the proxy we logged.
class CancelUpload extends FileUpload {
    private closed = false
    constructor (private inner: FileUpload) { super() }
    getName (): string { return this.inner.getName() }
    getMode (): number { return this.inner.getMode() }
    getSize (): number { return this.inner.getSize() }
    async read (): Promise<Uint8Array> {
        if (this.isCancelled()) { throw new Error('Cancelled') }
        const chunk = await this.inner.read()
        this.increaseProgress(chunk.length)
        return chunk
    }
    close (): void { if (this.closed) { return } this.closed = true; this.inner.close() }
}
class CancelDownload extends FileDownload {
    private closed = false
    constructor (private inner: FileDownload) { super() }
    getName (): string { return this.inner.getName() }
    getMode (): number { return this.inner.getMode() }
    getSize (): number { return this.inner.getSize() }
    async write (buffer: Uint8Array): Promise<void> {
        if (this.isCancelled()) { throw new Error('Cancelled') }
        await this.inner.write(buffer)
        this.increaseProgress(buffer.length)
    }
    close (): void { if (this.closed) { return } this.closed = true; this.inner.close() }
}

// Streams a remote file into an HTTP response for single-file DownloadURL
// drag-out. Same FileDownload base, so it shows in the panel log like any transfer.
class StreamDownload extends FileDownload {
    constructor (private res: any, private name: string, private mode: number, private size: number) { super() }
    getName (): string { return this.name }
    getMode (): number { return this.mode }
    getSize (): number { return this.size }
    async write (buffer: Uint8Array): Promise<void> {
        if (this.isCancelled()) { throw new Error('Cancelled') }
        if (!this.res.write(buffer)) {
            await new Promise<void>(r => this.res.once('drain', () => r()))
        }
        this.increaseProgress(buffer.length)
    }
    close (): void {
        // cancel() (log X) routes through here too — destroy so the receiving side
        // aborts instead of keeping a silently truncated file.
        if (this.isCancelled()) { try { this.res.destroy() } catch { /* gone */ } } else { this.res.end() }
    }
}

@Component({
    selector: 'sftp-panel-plugin',
    template: `
    <div class="sp-spine" *ngIf="collapsed" [title]="'SFTP Panel — hover to open' | translate"><span *ngIf="config.store.sftpPanel.spineLabel">SFTP Panel</span></div>
    <ng-container *ngIf="!collapsed">
    <div class="sp-header">
      <input *ngIf="editingPath !== null" class="form-control flex-grow-1" type="text" autofocus
        (keydown.enter)="confirmPath()" (keydown.esc)="editingPath = null; $event.stopPropagation()" (blur)="editingPath = null" [(ngModel)]="editingPath">
      <div class="sp-path flex-grow-1" *ngIf="editingPath === null" (click)="editPath()"
        [title]="'Click to edit path' | translate">{{ path }}</div>
      <button class="btn btn-link btn-sm" [title]="(config.store.sftpPanel.pinned ? 'Unpin (overlay)' : 'Pin panel (dock)') | translate" (click)="togglePin()">
        <i class="fas" [class.fa-thumbtack]="config.store.sftpPanel.pinned" [class.fa-map-pin]="!config.store.sftpPanel.pinned"></i>
      </button>
      <button class="btn btn-link btn-sm" [title]="'Refresh' | translate" (click)="navigate(path)"><i class="fas fa-sync-alt"></i></button>
      <button class="btn btn-link btn-sm" [title]="'Create directory' | translate" (click)="openCreateDirectoryModal()"><i class="fas fa-plus"></i></button>
      <button class="btn btn-link btn-sm" [title]="'New file' | translate" (click)="openCreateFileModal()"><i class="fas fa-file-medical"></i></button>
      <button class="btn btn-link btn-sm" [title]="(showHidden ? 'Hide dotfiles' : 'Show dotfiles') | translate" (click)="toggleHidden()">
        <i class="fas" [class.fa-eye]="showHidden" [class.fa-eye-slash]="!showHidden"></i>
      </button>
      <button class="btn btn-link btn-sm" [title]="'Upload files' | translate" (click)="upload()"><i class="fas fa-upload"></i></button>
      <button class="btn btn-link btn-sm" [title]="'Upload folder' | translate" (click)="uploadFolder()"><i class="fas fa-folder-plus"></i></button>
      <button class="btn btn-link btn-sm" [title]="'File transfers' | translate" (click)="showTransfers = !showTransfers"><i class="fas fa-exchange-alt"></i></button>
    </div>

    <div class="sp-filter">
      <div class="input-group input-group-sm">
        <input class="form-control form-control-sm" type="text" [placeholder]="'Filter...' | translate" [(ngModel)]="filterText"
          (input)="updateFiltered()" (keydown.escape)="clearFilter($event)"
          (keydown.arrowdown)="focusList(1, $event)" (keydown.arrowup)="focusList(-1, $event)">
        <button class="btn btn-secondary btn-sm" (click)="clearFilter()"><i class="fas fa-times"></i></button>
      </div>
    </div>

    <div class="sp-body" tabindex="0" (keydown)="onKeydown($event)" (contextmenu)="showFolderContextMenu($event)"
      (dragover)="onDropZoneOver($event)" (drop)="onDrop($event)">
      <div *ngIf="!sftp">{{ 'Connecting…' | translate }}</div>
      <div *ngIf="sftp">
        <div *ngIf="fileList === null">{{ 'Loading…' | translate }}</div>
        <div class="sp-scroll" *ngIf="fileList !== null">
          <div class="sp-table" [style.width.px]="tableWidth()">
            <div class="sp-row sp-head">
              <div class="sp-cell" [ngClass]="cellClass(k)" *ngFor="let k of orderedCols()" [style.width.px]="col[k].width"
                [class.sp-drop-target]="dropCol === k" draggable="true"
                (dragstart)="onColDragStart(k, $event)" (dragover)="onColDragOver(k, $event)"
                (dragleave)="onColDragLeave(k)" (drop)="onColDrop(k, $event)" (dragend)="onColDragEnd()"
                (click)="onHeaderClick(k)" (contextmenu)="headerMenu($event)">{{ colLabels[k] | translate }}
                <i class="fas" *ngIf="k !== 'perms'" [class.fa-caret-up]="sortIs(k,'asc')" [class.fa-caret-down]="sortIs(k,'desc')"></i>
                <span class="sp-resizer" (mousedown)="startColResize(k, $event)" (click)="$event.stopPropagation()" (dblclick)="autofitCol(k, $event)"></span></div>
            </div>

            <div class="sp-row sp-up" *ngIf="upVisible()" [class.sp-selected]="upCursor"
              (click)="onUpClick()" (dblclick)="goUp()">
              <div class="sp-cell" [ngClass]="cellClass(k)" *ngFor="let k of orderedCols()" [style.width.px]="col[k].width">
                <ng-container *ngIf="k === 'name'"><i class="fas fa-fw fa-level-up-alt"></i> ..</ng-container></div>
            </div>

            <div class="sp-row sp-item" *ngFor="let item of viewList; let i = index" [class.sp-selected]="isSelected(item)"
              draggable="true" (dragstart)="onDragOut(item, $event)"
              (click)="onRowClick(item, i, $event)" (dblclick)="open(item)" (contextmenu)="showContextMenu(item, $event)">
              <div class="sp-cell" [ngClass]="cellClass(k)" *ngFor="let k of orderedCols()" [style.width.px]="col[k].width" [ngSwitch]="k">
                <ng-container *ngSwitchCase="'name'"><i class="fa-fw" [class]="icon(item)"></i> {{item.name}}</ng-container>
                <ng-container *ngSwitchCase="'size'">{{item.isDirectory ? '' : sizeText(item.size)}}</ng-container>
                <ng-container *ngSwitchCase="'modified'">{{item.modified | tabbyDate}}</ng-container>
                <ng-container *ngSwitchCase="'owner'">{{item.owner}}</ng-container>
                <ng-container *ngSwitchCase="'group'">{{item.group}}</ng-container>
                <ng-container *ngSwitchCase="'perms'">{{mode(item)}}</ng-container></div>
            </div>
          </div>
        </div>
        <div class="sp-empty" *ngIf="fileList !== null && viewList.length === 0 && filterActive()">{{ 'No files match "{filter}"' | translate:{ filter: filterText } }}</div>
      </div>
    </div>

    <div class="sp-bulk" *ngIf="sftp && fileList !== null">
      <span>{{viewList.length}} {{ 'items' | translate }}</span>
      <span *ngIf="selection.size > 0">· {{selection.size}} {{ 'selected' | translate }}<ng-container *ngIf="selectedSize() > 0"> ({{sizeText(selectedSize())}})</ng-container></span>
      <span class="flex-grow-1"></span>
      <ng-container *ngIf="selectedItems().length > 1">
        <button class="btn btn-sm btn-link" (click)="downloadSelected()"><i class="fas fa-download me-1"></i>{{ 'Download' | translate }}</button>
        <button class="btn btn-sm btn-link text-danger" (click)="deleteSelected()"><i class="fas fa-trash me-1"></i>{{ 'Delete' | translate }}</button>
      </ng-container>
    </div>

    <div class="sp-tx-resizer" *ngIf="showTransfers" (mousedown)="startTxResize($event)"></div>
    <div class="sp-transfers" *ngIf="showTransfers" tabindex="0" (keydown)="onLogKeydown($event)"
         [style.height.px]="config.store.sftpPanel.transfersHeight">
      <div class="sp-tx-head">
        <span>{{ 'Log' | translate }}</span>
        <button class="btn btn-link btn-sm ms-auto" [title]="'Clear all' | translate" (click)="log.clearAll()"><i class="fas fa-times"></i></button>
      </div>
      <div class="sp-tx-body">
      <div class="sp-tx-empty" *ngIf="log.entries.length === 0">{{ 'No log entries' | translate }}</div>
      <div class="sp-tx-row" *ngFor="let e of log.entries; let i = index; trackBy: trackLog" [class.sp-selected]="selectedLogIds.has(e.id)"
        (click)="onLogRowClick(e, i, $event)" (contextmenu)="onLogContextMenu(e, i, $event)">
        <i class="fas fa-fw" [ngClass]="logIcon(e)"></i>
        <span class="sp-tx-time">{{txTime(e)}}</span>
        <span class="sp-tx-name" [ngbTooltip]="log.fullText(e)" container="body">{{e.text}}</span>
        <span class="sp-tx-size" *ngIf="e.kind === 'transfer'">{{txProgress(e)}}</span>
        <i class="fas fa-fw fa-stop-circle sp-tx-stop" *ngIf="(e.kind === 'transfer' && txActive(e)) || (e.kind === 'message' && e.onCancel)"
           [title]="'Stop' | translate" (click)="stopLog(e, $event)"></i>
        <i class="fas fa-fw sp-tx-status" *ngIf="e.kind === 'transfer'"
           [class.fa-spinner]="txActive(e)" [class.fa-spin]="txActive(e)"
           [class.fa-check]="e.transfer.isComplete()" [class.fa-times]="e.transfer.isCancelled()"></i>
        <div class="sp-tx-bar" *ngIf="e.kind === 'transfer' && txActive(e)">
          <div class="sp-tx-bar-fill" [style.width.%]="txPercent(e)"></div>
        </div>
      </div>
      </div>
    </div>
    </ng-container>
    `,
    styles: [`
    :host { display: flex; flex-direction: column; height: 100%; background: var(--theme-bg, #1d1f21); }
    .sp-spine { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; cursor: pointer; user-select: none; }
    .sp-spine span { writing-mode: vertical-rl; text-orientation: mixed; letter-spacing: 3px; font-weight: bold; font-size: 12px; opacity: .6; }
    .sp-spine:hover span { opacity: 1; }
    .sp-header { display: flex; align-items: center; padding: 4px 8px; flex: none; gap: 2px; }
    .sp-header .btn { padding: 2px 6px; }
    .sp-path { cursor: text; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: monospace; padding: 2px 6px; border-radius: 3px; align-self: center; }
    .sp-path:hover { background: rgba(127,127,127,.15); }
    .sp-filter { flex: none; padding: 2px 6px; }
    .sp-filter .form-control-sm { font-size: 12px; padding: 1px 6px; }
    .sp-body { flex: 1 1 0; min-height: 0; overflow: auto; padding: 0 0 4px; }
    .sp-body:focus { outline: none; }
    .sp-scroll { width: max-content; min-width: 100%; }
    .sp-table { min-width: 100%; }
    .sp-row { display: flex; align-items: center; }
    .sp-head { position: sticky; top: 0; z-index: 1; font-weight: bold; user-select: none; background: var(--theme-bg, #1d1f21); }
    .sp-head .sp-cell { cursor: pointer; }
    .sp-head .sp-drop-target { box-shadow: inset 2px 0 0 var(--theme-fg, #fff); }
    .sp-cell { padding: 2px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; position: relative; box-sizing: border-box; }
    .sp-size, .sp-date, .sp-mode { font-family: monospace; font-size: 12px; opacity: .6; text-align: right; }
    .sp-owner, .sp-group { font-family: monospace; font-size: 12px; opacity: .6; }
    .sp-resizer { position: absolute; top: 0; right: 0; width: 5px; height: 100%; cursor: col-resize; border-right: 1px solid rgba(255,255,255,.12); }
    .sp-resizer:hover { background: rgba(255,255,255,.15); border-right-color: rgba(255,255,255,.4); }
    .sp-item { cursor: default; }
    .sp-item:hover { background: rgba(255,255,255,.05); }
    .sp-selected { background: rgba(255,255,255,.13) !important; }
    .sp-empty { text-align: center; opacity: .6; padding: 12px; }
    .sp-bulk { flex: none; display: flex; align-items: center; gap: 6px; padding: 2px 10px; font-size: 12px; border-top: 1px solid rgba(255,255,255,.1); }
    .sp-bulk > span { opacity: .7; }
    .sp-bulk .btn { padding: 0 6px; font-size: 12px; }
    .sp-tx-resizer { flex: none; height: 5px; cursor: row-resize; border-top: 1px solid rgba(255,255,255,.12); }
    .sp-tx-resizer:hover { background: rgba(255,255,255,.15); }
    .sp-transfers { flex: none; display: flex; flex-direction: column; overflow: hidden; font-size: 12px; }
    .sp-tx-body { flex: 1 1 auto; overflow: auto; }
    .sp-tx-head { flex: none; display: flex; align-items: center; padding: 2px 8px; font-weight: bold; opacity: .8; background: var(--theme-bg, #1d1f21); }
    .sp-tx-empty { padding: 6px 10px; opacity: .5; }
    .sp-tx-row { display: flex; align-items: center; gap: 6px; padding: 1px 8px; position: relative; }
    .sp-tx-row:hover { background: rgba(255,255,255,.05); }
    .sp-tx-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(255,255,255,.08); }
    .sp-tx-bar-fill { height: 100%; background: var(--bs-info, #4fc3f7); transition: width .3s linear; }
    .sp-tx-time { font-family: monospace; opacity: .6; white-space: nowrap; }
    .sp-tx-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sp-tx-size { font-family: monospace; opacity: .6; white-space: nowrap; }
    .sp-tx-stop { opacity: .6; color: #e57373; cursor: pointer; }
    .sp-tx-stop:hover { opacity: 1; }
    .sp-tx-status { opacity: .7; }
    .sp-tx-status.fa-check { color: #4caf50; }
    .sp-tx-status.fa-times { color: #e57373; }
    .sp-transfers:focus { outline: none; }
    .sp-tx-row { cursor: default; }
    .sp-log-error { color: #e57373; }
    .sp-log-warn { color: #e0a030; }
    .sp-log-info { opacity: .6; }
    `],
})
export class SftpPanelComponent implements OnDestroy {
    @Input() session: SSHSessionLike | null = null
    // Terminal shell session (tab.session), set by the mount service alongside
    // `session`; polled so we open SFTP only after the shell channel is up.
    shellSession: ShellSessionLike | null = null
    @Input() collapsed = false   // strip mode (unpinned + not hovered): show only the spine
    @Output() escaped = new EventEmitter<void>()   // Esc: mount collapses the strip when unpinned

    sftp: SFTPSession
    path = ''   // '' = not yet resolved (first open); set to an absolute path by navigate()
    fileList: PanelFile[] | null = null
    viewList: PanelFile[] = []
    editingPath: string | null = null
    get showTransfers (): boolean { return this.config.store.sftpPanel.transfersVisible }
    set showTransfers (v: boolean) { this.config.store.sftpPanel.transfersVisible = v; this.config.save() }
    filterText = ''
    selection = new Set<string>()   // fullPath set
    private lastIndex = -1
    selectedLogIds = new Set<number>()
    lastLogIndex = -1
    upCursor = false   // keyboard cursor is on the ".." up-row (a virtual index -1, not in viewList)
    protected contextMenuProviders: SFTPContextMenuItemProvider[] = []

    constructor (
        private ngbModal: NgbModal,
        private config: ConfigService,
        private translate: TranslateService,
        public platform: PlatformService,
        private cdr: ChangeDetectorRef,
        private host: ElementRef,
        private app: AppService,
        public log: LogService,
        private localEdit: LocalEditService,
        injector: Injector,
    ) {
        // The `SFTPContextMenuItemProvider` symbol imported above comes from the plugin's
        // OWN dev copy of tabby-ssh (webpack externals → require resolves plugin-local first),
        // so it's a different token than Tabby's runtime — @Inject-ing it finds nothing.
        // Resolve the RUNTIME token via Electron's node require, then pull the multi-provider
        // instances (CommonSFTPContextMenu, EditSFTPContextMenu) out of the injector.
        let provs: SFTPContextMenuItemProvider[] = []
        try {
            const token = (window as any).require('tabby-ssh').SFTPContextMenuItemProvider
            provs = injector.get(token, []) as SFTPContextMenuItemProvider[]
        } catch { /* provider lookup failed — leave menu empty */ }
        this.contextMenuProviders = (provs ?? []).sort((a, b) => a.weight - b.weight)
    }

    get col () { return this.config.store.sftpPanel.columns }

    private isRoot: boolean | null = null   // cached `id -u`==0; gates chown UI in the perms dialog
    private users: string[] | null = null   // cached server users/groups for the chown dropdowns
    private groups: string[] | null = null

    // ---- columns: order, labels, reorder-drag, autofit ----
    readonly colLabels: Record<Col, string> = { name: 'Name', size: 'Size', modified: 'Modified', owner: 'Owner', group: 'Group', perms: 'Permissions' }
    private readonly cellClasses: Record<Col, string> = { name: 'sp-name', size: 'sp-size', modified: 'sp-date', owner: 'sp-owner', group: 'sp-group', perms: 'sp-mode' }
    dropCol: Col | null = null       // header cell currently hovered as drop target
    private dragCol: Col | null = null

    get columnOrder (): Col[] { return this.config.store.sftpPanel.columnOrder }
    orderedCols (): Col[] { return this.columnOrder.filter(k => this.col[k].visible) }
    cellClass (k: Col): string { return this.cellClasses[k] }
    onHeaderClick (k: Col): void { if (k !== 'perms') { this.setSort(k as SortColumn) } }  // perms not sortable

    onColDragStart (k: Col, ev: DragEvent): void {
        this.dragCol = k
        ev.dataTransfer?.setData('text/plain', k)   // Firefox won't start a drag without data
        if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move' }
    }
    onColDragOver (k: Col, ev: DragEvent): void {
        if (!this.dragCol) { return }               // ignore file drag-in etc.
        ev.preventDefault()                          // allow the drop
        if (ev.dataTransfer) { ev.dataTransfer.dropEffect = 'move' }
        if (this.dropCol !== k) { this.dropCol = k; this.cdr.detectChanges() }
    }
    onColDragLeave (k: Col): void { if (this.dropCol === k) { this.dropCol = null } }
    onColDrop (k: Col, ev: DragEvent): void {
        ev.preventDefault()
        if (this.dragCol) {
            this.config.store.sftpPanel.columnOrder = moveColumn(this.columnOrder, this.dragCol, k)
            this.config.save()
        }
        this.onColDragEnd()
    }
    onColDragEnd (): void { this.dragCol = null; this.dropCol = null; this.cdr.detectChanges() }

    // Double-click a resizer: fit the column to its widest visible cell. scrollWidth
    // gives full content width even when ellipsis-clipped; header label included.
    autofitCol (k: Col, ev: MouseEvent): void {
        ev.preventDefault(); ev.stopPropagation()
        const sel = '.sp-table .' + this.cellClasses[k]
        let max = 0
        this.host.nativeElement.querySelectorAll(sel).forEach((el: HTMLElement) => { max = Math.max(max, el.scrollWidth) })
        if (max > 0) { this.col[k].width = Math.max(40, max + 10); this.cdr.detectChanges(); this.config.save() }
    }

    togglePin (): void {
        const s = this.config.store.sftpPanel
        s.pinned = !s.pinned
        this.config.save()
    }

    private configSub?: Subscription
    private transferSub?: Subscription
    private sessionSub?: { unsubscribe(): void }   // current session's willDestroy$
    private opening = false

    async ngOnInit (): Promise<void> {
        // Config (e.g. pinned, columns) is global; re-render this panel when it
        // changes elsewhere — inactive tabs' dynamic views aren't ticked otherwise.
        this.configSub = this.config.changed$.subscribe(() => this.cdr.detectChanges())
        // Transfer stream fires from outside Angular's zone; force CD so the list updates
        // immediately instead of on a later focus/click tick (the render-lag fix).
        this.transferSub = this.log.changed$.subscribe(() => this.cdr.detectChanges())
        this.startDragServer()
        await this.openIfReady()
    }

    // The frame is mounted before the SSH session connects (so the panel appears
    // immediately); the mount service calls this once the session is ready. Also
    // called on reconnect, when Tabby swaps in a NEW SSHSession — in that case drop
    // the dead SFTP handle so openIfReady reopens against the new connection.
    async setSession (session: SSHSessionLike): Promise<void> {
        const swapped = this.session && session !== this.session
        this.session = session
        if (swapped) { this.sftp = null as any; this.opening = false }
        // Best-effort: if the connection is torn down, flip back to "Connecting…"
        // immediately instead of showing a stale, click-erroring listing. Not
        // required for recovery — the session swap above handles that on reconnect.
        this.sessionSub?.unsubscribe()
        this.sessionSub = session.willDestroy$?.subscribe(() => {
            this.sftp = null as any
            this.cdr.detectChanges()
        })
        await this.openIfReady()
        this.cdr.detectChanges()
    }

    private async openIfReady (): Promise<void> {
        if (this.sftp || this.opening || !this.session) { return }
        this.opening = true
        try {
            // Wait for the shell channel to come up before opening SFTP, so the
            // server's MotD (sent on the shell channel) isn't clobbered by the two
            // channel-opens racing. Wait even while shellSession is still null: on a
            // multiplexed reconnect (new tab to an already-connected server) the
            // connection is instant, so shellSession is wired a beat later — skipping
            // the wait there races the shell channel and swallows the MotD. The field
            // is updated live by the mount service.
            // poll every 50ms, cap at 5s so a shell-less session still connects.
            for (let i = 0; i < 100 && !this.shellSession?.shell; i++) {
                await new Promise(r => setTimeout(r, 50))
            }
            // Shell channel is open, but the server streams the MotD a beat later.
            // Opening SFTP inside that window makes the server swallow the MotD
            // (worst on multiplexed connections, where the channel opens instantly
            // and there's no auth latency to hide behind). No signal marks "MotD
            // done" — it's raw shell bytes — so grace-wait before opening SFTP.
            // 400ms covers a typical multi-line MotD; raise if a slow/
            // chatty server still loses it, or drop once a real signal exists.
            await new Promise(r => setTimeout(r, 400))
            this.sftp = await this.session.openSFTP()
            // First open (path still ''): go to the configured start folder ('~' →
            // remote home via a one-shot `pwd` exec, since russh has no realpath).
            // Reconnect (path already set): restore that folder, don't re-resolve.
            let target = this.path
            if (!target) {
                const start = this.config.store.sftpPanel.startDirectory as string
                const home = startNeedsHome(start) ? await this.resolveHome() : null
                target = resolveStartPath(start, home)
            }
            await this.navigate(target)
            // Folder gone after a reconnect (or start dir invalid) → fall back to '/'.
            if (!this.fileList) { await this.navigate('/') }
        } catch (e) {
            this.log.log('error', this.translate.instant('Could not open SFTP'), String(e))
        } finally {
            this.opening = false
        }
    }

    // Run one command over a one-shot exec channel (no PTY/login shell → clean output).
    // Returns stdout, or null on any failure/timeout. Shared by home-resolve, ls-owners,
    // root-detect and chown. `ssh` is the SSHSession's private AuthenticatedSSHClient —
    // not in the structural type, reached via the cast below.
    private async exec (cmd: string, timeoutMs = 5000): Promise<string | null> {
        try {
            const ssh = (this.session as any)?.ssh
            if (!ssh?.openSessionChannel) { return null }
            const ch = await ssh.activateChannel(await ssh.openSessionChannel())
            let out = ''
            const dec = new TextDecoder()
            const done = new Promise<void>(resolve => {
                ch.data$.subscribe((d: Uint8Array) => { out += dec.decode(d) })
                ch.closed$.subscribe(() => resolve())
                ch.eof$?.subscribe(() => resolve())
            })
            await ch.requestExec(cmd)
            // timeoutMs <= 0 means wait for the channel to close (used by cp -r on big trees).
            if (timeoutMs > 0) {
                await Promise.race([done, new Promise(r => setTimeout(r, timeoutMs))])
            } else {
                await done
            }
            try { await ch.close() } catch { /* already closed */ }
            return out
        } catch {
            return null
        }
    }

    private async resolveHome (): Promise<string | null> {
        const out = await this.exec('pwd')
        if (out === null) { return null }
        const home = out.trim().split('\n').pop()?.trim() ?? ''
        return home.startsWith('/') ? home : null
    }

    ngOnDestroy (): void {
        this.configSub?.unsubscribe()
        this.transferSub?.unsubscribe()
        this.sessionSub?.unsubscribe()
        try { this.dragServer?.close() } catch { /* already closed */ }
    }

    async navigate (newPath: string): Promise<void> {
        const previous = this.path
        // Reload (same folder, e.g. refresh button / F5 / post-op refresh): keep the filter,
        // the marked file/folder(s) and the scroll position instead of resetting them.
        const reload = newPath === previous
        // Going up to the direct parent (via .., goUp hotkey, or parent breadcrumb):
        // mark the folder we came from once the parent listing loads.
        const wentUp = previous !== newPath && newPath === path.dirname(previous)
        const keepSel = reload ? new Set(this.selection) : null
        const scrollBody = this.host.nativeElement.querySelector('.sp-body') as HTMLElement | null
        const keepScroll = reload ? scrollBody?.scrollTop ?? 0 : 0
        this.path = newPath
        if (!reload) { this.clearFilter() }
        this.selection.clear(); this.lastIndex = -1; this.upCursor = false

        this.fileList = null
        this.viewList = []
        try {
            this.fileList = await this.sftp.readdir(this.path)
        } catch (error: any) {
            this.log.log('error', this.translate.instant('Cannot open {path}', { path: newPath }), error.message)
            if (previous && previous !== newPath) { this.path = previous; await this.navigate(previous) }
            return
        }
        this.resort()
        if (keepSel) {
            // Prune to items that still exist after the reload; recompute the cursor.
            for (const fp of keepSel) { if (this.viewList.some(i => i.fullPath === fp)) { this.selection.add(fp) } }
            this.lastIndex = this.viewList.findIndex(i => this.selection.has(i.fullPath))
        }
        if (wentUp) {
            const i = this.viewList.findIndex(item => item.fullPath === previous)
            if (i >= 0) { this.selection.add(previous); this.lastIndex = i }
        }
        this.cdr.detectChanges()   // async continuation: nothing else triggers CD here
        void this.fillOwners(this.path)   // best-effort owner/group via `ls -la`, fills in async
        if (reload && scrollBody) { scrollBody.scrollTop = keepScroll }
        if (wentUp && this.lastIndex >= 0) {
            ;(this.host.nativeElement.querySelectorAll('.sp-item')[this.lastIndex] as HTMLElement | undefined)
                ?.scrollIntoView({ block: 'center' })
        }
    }

    // Owner/group aren't in russh's SFTP attrs (uid/gid come back 0, names empty), so fetch the
    // real names with `ls -la` over a one-shot exec channel and merge them into the current list.
    // Best-effort and non-blocking: no shell / timeout / a re-navigate mid-flight → cells stay
    // blank. Mutates the file objects in place (viewList holds the same refs) then repaints.
    private async fillOwners (dir: string): Promise<void> {
        try {
            const out = await this.exec('ls -la ' + shQuote(dir))
            if (out === null || dir !== this.path || !this.fileList) { return }   // failed / navigated away
            const owners = parseLsOwners(out)
            for (const f of this.fileList) {
                const o = owners.get(f.name)
                if (o) { f.owner = o.owner; f.group = o.group }
            }
            this.cdr.detectChanges()
        } catch { /* best-effort: leave owner/group blank */ }
    }

    // ---- sorting ----
    resort (): void {
        if (!this.fileList) { this.viewList = []; return }
        const s = this.config.store.sftpPanel.sort
        const list = this.showHidden ? this.fileList : this.fileList.filter(i => !i.name.startsWith('.'))
        const sorted = sortFiles(list, s.column as SortColumn, s.dir as SortDir)
        this.viewList = filterFiles(sorted, this.filterActive() ? this.filterText : '')
    }
    get showHidden (): boolean { return this.config.store.sftpPanel.showHidden }
    toggleHidden (): void {
        this.config.store.sftpPanel.showHidden = !this.showHidden
        this.config.save()
        // Drop selected items that just became invisible.
        this.resort()
        this.selection = new Set(this.viewList.filter(i => this.selection.has(i.fullPath)).map(i => i.fullPath))
        this.lastIndex = this.viewList.findIndex(i => this.selection.has(i.fullPath))
    }
    setSort (column: SortColumn): void {
        const s = this.config.store.sftpPanel.sort
        if (s.column === column) { s.dir = s.dir === 'asc' ? 'desc' : 'asc' } else { s.column = column; s.dir = 'asc' }
        this.config.save(); this.resort()
    }
    sortIs (column: SortColumn, dir: SortDir): boolean {
        const s = this.config.store.sftpPanel.sort
        return s.column === column && s.dir === dir
    }

    // ---- filter ----
    filterActive (): boolean { return this.filterText.trim() !== '' }
    // The ".." up-row is shown (and keyboard-reachable) only when not at root and no filter.
    upVisible (): boolean { return this.path !== '/' && !this.filterActive() }
    onUpClick (): void {
        this.selection.clear(); this.lastIndex = -1; this.upCursor = true
        ;(this.host.nativeElement.querySelector('.sp-body') as HTMLElement | null)?.focus({ preventScroll: true })
        this.cdr.detectChanges()
    }
    updateFiltered (): void { this.resort() }
    clearFilter (ev?: Event): void {
        // Esc in the filter: if there's text, clear it and swallow Esc; if empty, let it
        // bubble to the host Esc handler so the panel collapses.
        if (ev && !this.filterText) { return }
        ev?.stopPropagation()
        this.filterText = ''; this.resort()
    }

    // ---- columns ----
    tableWidth (): number {
        const c = this.col
        return this.columnOrder.reduce((w, k) => w + (c[k].visible ? c[k].width : 0), 0)
    }
    startColResize (key: Col, ev: MouseEvent): void {
        ev.preventDefault(); ev.stopPropagation()
        const startX = ev.clientX
        const startW = this.col[key].width
        const move = (m: MouseEvent) => { this.col[key].width = Math.max(40, startW + (m.clientX - startX)); this.cdr.detectChanges() }
        const up = () => {
            window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
            this.config.save()
        }
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    }
    headerMenu (ev: MouseEvent): void {
        ev.preventDefault()
        ev.stopPropagation()   // don't bubble to the blank-area folder menu on .sp-body
        const c = this.col
        const items: MenuItemOptions[] = this.columnOrder.map(k => ({
            label: this.translate.instant(this.colLabels[k]),
            type: 'checkbox',
            checked: c[k].visible,
            enabled: !(k === 'name' && c[k].visible),   // never hide the last/name column to nothing
            click: () => { c[k].visible = !c[k].visible; this.config.save() },
        }))
        this.platform.popupContextMenu(items, ev)
    }

    // ---- selection ----
    isSelected (item: SFTPFile): boolean { return this.selection.has(item.fullPath) }
    onRowClick (item: SFTPFile, index: number, ev: MouseEvent): void {
        this.upCursor = false
        if (ev.shiftKey && this.lastIndex >= 0) {
            const [a, b] = [this.lastIndex, index].sort((x, y) => x - y)
            this.selection.clear()
            for (let i = a; i <= b; i++) { this.selection.add(this.viewList[i].fullPath) }
        } else if (ev.ctrlKey || ev.metaKey) {
            if (this.selection.has(item.fullPath)) { this.selection.delete(item.fullPath) } else { this.selection.add(item.fullPath) }
            this.lastIndex = index
        } else {
            this.selection.clear(); this.selection.add(item.fullPath); this.lastIndex = index
        }
        // Focus the list so arrow-key navigation works right after a click.
        ;(this.host.nativeElement.querySelector('.sp-body') as HTMLElement | null)?.focus({ preventScroll: true })
    }
    selectedItems (): SFTPFile[] { return this.viewList.filter(i => this.selection.has(i.fullPath)) }
    selectAll (): void {
        this.upCursor = false
        this.selection = new Set(this.viewList.map(i => i.fullPath))
        this.lastIndex = this.viewList.length - 1
    }
    // Total size of selected files (dirs contribute 0 — their `size` is meaningless).
    selectedSize (): number {
        return this.selectedItems().reduce((s, i) => s + (i.isDirectory ? 0 : i.size), 0)
    }

    // ---- keyboard navigation (focus the file list, then arrows / Enter / Backspace) ----
    onKeydown (ev: KeyboardEvent): void {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
            ev.preventDefault()
            this.selectAll()
            return
        }
        switch (ev.key) {
            case 'Delete':
                if (this.selectedItems().length > 0) { ev.preventDefault(); this.deleteSelected(ev.shiftKey) }
                return
            case 'F2':
                if (this.lastIndex >= 0 && this.lastIndex < this.viewList.length) {
                    ev.preventDefault(); this.renameItem(this.viewList[this.lastIndex])
                }
                return
            case 'ArrowDown': ev.preventDefault(); this.moveCursor(1); return
            case 'ArrowUp': ev.preventDefault(); this.moveCursor(-1); return
            case 'PageDown': ev.preventDefault(); this.moveCursor(this.pageJump()); return
            case 'PageUp': ev.preventDefault(); this.moveCursor(-this.pageJump()); return
            case 'Home': ev.preventDefault(); this.moveCursor(-this.viewList.length); return
            case 'End': ev.preventDefault(); this.moveCursor(this.viewList.length); return
            case 'Enter':
                if (this.upCursor) { ev.preventDefault(); this.goUp(); return }
                if (this.lastIndex >= 0 && this.lastIndex < this.viewList.length) {
                    ev.preventDefault(); this.open(this.viewList[this.lastIndex])
                }
                return
            case 'ArrowLeft': case 'Backspace':
                if (this.path !== '/') { ev.preventDefault(); this.goUp() }
                return
            case 'Escape': ev.preventDefault(); ev.stopPropagation(); this.focusTerminal(); return
        }
        // Any printable char while the list is focused starts/extends the filter.
        if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
            ev.preventDefault()
            this.filterText += ev.key
            this.resort()
            this.cdr.detectChanges()
            ;(this.host.nativeElement.querySelector('.sp-filter input') as HTMLElement | null)?.focus()
        }
    }

    // Esc anywhere in the panel (buttons, hover-opened strip, nothing focused) collapses it —
    // reaches this via bubbling unless an inner handler (filter with text, path edit) swallowed it.
    @HostListener('keydown.escape')
    onHostEscape (): void { this.focusTerminal() }

    // F5 anywhere in the panel (list, filter, buttons) refreshes the listing —
    // host-level so it works regardless of which inner element has focus.
    @HostListener('keydown.f5', ['$event'])
    onHostF5 (ev: KeyboardEvent): void {
        ev.preventDefault()
        if (this.sftp && this.path) { this.navigate(this.path) }
    }

    // Escape: drop focus from the panel and hand it back to the terminal. Blur first (removes
    // panel focus even if the terminal refocus below no-ops), then use Tabby's tab API, then
    // fall back to focusing xterm's hidden textarea directly (scoped to this tab-body).
    private focusTerminal (): void {
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        const top: any = this.app.activeTab
        const pane = top?.getFocusedTab?.() ?? top
        try { top?.focus?.(pane) } catch { /* not a split-tab / no focus method */ }
        const tabBody = this.host.nativeElement.parentElement as HTMLElement | null
        ;(tabBody?.querySelector('.xterm-helper-textarea') as HTMLElement | null)?.focus()
        this.escaped.emit()
    }

    // Arrow up/down from the filter field jumps focus into the file list and starts navigating.
    focusList (delta: number, ev: Event): void {
        ev.preventDefault()
        ;(this.host.nativeElement.querySelector('.sp-body') as HTMLElement | null)?.focus({ preventScroll: true })
        this.moveCursor(delta)
    }

    // Rows per PageUp/Down jump: how many fit in the visible body, min 1.
    private pageJump (): number {
        const body = this.host.nativeElement.querySelector('.sp-body') as HTMLElement | null
        const row = this.host.nativeElement.querySelector('.sp-item') as HTMLElement | null
        if (!body || !row || !row.offsetHeight) { return 10 }  // fallback before rows render
        return Math.max(1, Math.floor(body.clientHeight / row.offsetHeight) - 1)
    }

    // Move the single-selection cursor, scroll it into view. Virtual index -1 = the ".."
    // up-row (when shown); 0..n-1 = viewList rows.
    private moveCursor (delta: number): void {
        const up = this.upVisible()
        if (!this.viewList.length && !up) { return }
        const cur = this.upCursor ? -1 : this.lastIndex
        let i = cur < 0 && !this.upCursor
            ? (delta > 0 ? 0 : this.viewList.length - 1)   // first move from nothing selected
            : cur + delta
        i = Math.max(up ? -1 : 0, Math.min(this.viewList.length - 1, i))
        this.selection.clear()
        if (i < 0) {
            this.upCursor = true; this.lastIndex = -1
        } else {
            this.upCursor = false; this.lastIndex = i; this.selection.add(this.viewList[i].fullPath)
        }
        this.cdr.detectChanges()
        const target = i < 0
            ? this.host.nativeElement.querySelector('.sp-up')
            : this.host.nativeElement.querySelectorAll('.sp-item')[i]
        ;(target as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
    }

    // ---- open (double-click) ----
    icon (item: SFTPFile): string { return getIcon(item) }
    mode (item: SFTPFile): string { return getModeString(item) }
    sizeText (bytes: number): string { return formatSize(bytes) }
    txTime (e: LogEntry): string { return formatTransferTime(e.time, new Date()) }
    txActive (e: LogEntry): boolean { return !!e.transfer && !e.transfer.isComplete() && !e.transfer.isCancelled() }
    txPercent (e: LogEntry): number {
        const size = e.transfer?.getSize() ?? 0
        return size ? Math.min(100, 100 * e.transfer!.getCompletedBytes() / size) : 0
    }
    trackLog = (_: number, e: LogEntry): number => e.id
    stopLog (e: LogEntry, ev: MouseEvent): void {
        ev.stopPropagation()
        if (e.kind === 'message') { e.onCancel?.(); return }
        this.log.stop(e)
    }
    // Active: "1.2 MB / 5.0 MB (24%) · 3.1 MB/s". Done: just the total. Polled every
    // 300ms by LogService while a transfer is active, so it ticks live.
    txProgress (e: LogEntry): string {
        const t = e.transfer
        if (!t) { return this.sizeText(e.size ?? 0) }
        if (!this.txActive(e)) { return this.sizeText(e.size ?? t.getSize()) }
        const done = t.getCompletedBytes(), total = t.getSize()
        const pct = total ? Math.min(100, Math.round(100 * done / total)) : 0
        const speed = t.getSpeed()
        return `${this.sizeText(done)} / ${this.sizeText(total)} (${pct}%)`
            + (speed > 0 ? ` · ${this.sizeText(speed)}/s` : '')
    }

    logIcon (e: LogEntry): string {
        if (e.kind === 'transfer') { return e.isUpload ? 'fa-arrow-up' : 'fa-arrow-down' }
        if (e.level === 'error') { return 'fa-times-circle sp-log-error' }
        if (e.level === 'warn') { return 'fa-exclamation-triangle sp-log-warn' }
        return 'fa-info-circle sp-log-info'
    }

    // ---- log selection / copy ----
    onLogRowClick (e: LogEntry, i: number, ev: MouseEvent): void {
        this.selectedLogIds = computeLogSelection(
            e.id, i, this.lastLogIndex, this.selectedLogIds,
            { shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey },
            this.log.entries.map(x => x.id),
        )
        if (!ev.shiftKey) { this.lastLogIndex = i }
    }

    onLogKeydown (ev: KeyboardEvent): void {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c') {
            ev.preventDefault()
            ev.stopPropagation()   // don't let Tabby's global hotkeys eat it
            this.copyLog()
        }
    }

    private copyLog (): void {
        if (this.selectedLogIds.size === 0) { return }
        const text = this.log.entries
            .filter(e => this.selectedLogIds.has(e.id))
            .map(e => this.log.fullText(e))
            .join('\n')
        // navigator.clipboard — available in Tabby's Electron renderer.
        navigator.clipboard.writeText(text).catch(() => this.log.log('warn', this.translate.instant('Copy failed')))
    }

    onLogContextMenu (e: LogEntry, i: number, ev: MouseEvent): void {
        ev.preventDefault()   // suppress the native menu (matches showContextMenu)
        if (!this.selectedLogIds.has(e.id)) {
            this.selectedLogIds = new Set([e.id])
            this.lastLogIndex = i
        }
        this.platform.popupContextMenu([
            { label: this.translate.instant('Copy'), click: () => this.copyLog() },
            { label: this.translate.instant('Clear'), click: () => this.log.clearAll() },
        ], ev)
    }
    // Drag the top edge to resize the transfer list; dragging up grows it. Clamped to
    // [80px, 60% of the panel] and persisted.
    startTxResize (ev: MouseEvent): void {
        ev.preventDefault()
        const startY = ev.clientY
        const s = this.config.store.sftpPanel
        const startH = s.transfersHeight
        const panelH = this.host.nativeElement.clientHeight || 400
        const move = (m: MouseEvent) => {
            s.transfersHeight = clampSize(startH + (startY - m.clientY), panelH, 80)
            this.cdr.detectChanges()
        }
        const up = () => {
            window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
            this.config.save()
        }
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    }
    goUp (): void { this.navigate(path.dirname(this.path)) }

    async open (item: SFTPFile): Promise<void> {
        if (item.isDirectory) { await this.navigate(item.fullPath); return }
        if (item.isSymlink) {
            const target = path.resolve(this.path, await this.sftp.readlink(item.fullPath))
            const stat = await this.sftp.stat(target)
            if (stat.isDirectory) { await this.navigate(item.fullPath); return }
            if (await this.tryEdit(item, stat.mode, stat.size)) { return }
            await this.download(item.fullPath, stat.mode, stat.size); return
        }
        if (await this.tryEdit(item, item.mode, item.size)) { return }
        await this.download(item.fullPath, item.mode, item.size)
    }

    // Returns true when it handled the open (edit mode); false → caller downloads instead.
    private async tryEdit (item: SFTPFile, mode: number, size: number): Promise<boolean> {
        if (this.config.store.sftpPanel.fileClickAction !== 'edit') { return false }
        await this.editFile(item, mode, size)
        return true
    }

    // Open in the configured editor (or OS default if none), guarding large likely-binary files.
    async editFile (item: SFTPFile, mode: number, size: number): Promise<void> {
        const exe = await this.localEdit.resolveEditor()
        if (exe && isBigFile(size, this.config.store.sftpPanel.editorMaxSizeMB)) {
            const r = await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant('This file is large ({size}) and may be binary. Open it in the editor anyway?', { size: formatSize(size) }),
                buttons: [this.translate.instant('Open'), this.translate.instant('Cancel')], defaultId: 0, cancelId: 1,
            } as any)
            if ((r as any).response !== 0) { return }
        }
        const opener = exe ? this.localEdit.spawnOpener(exe) : this.localEdit.defaultOpener
        try {
            await this.localEdit.edit(this.sftp, item, mode, size, opener)
        } catch (e: any) {
            this.log.log('error', this.translate.instant('Could not open {name}', { name: item.name }), e?.message)
        }
    }

    // Per-file override: always open with the OS default app, bypassing the configured editor.
    async openWithDefault (item: SFTPFile, mode: number, size: number): Promise<void> {
        try {
            await this.localEdit.edit(this.sftp, item, mode, size, this.localEdit.defaultOpener)
        } catch (e: any) {
            this.log.log('error', this.translate.instant('Could not open {name}', { name: item.name }), e?.message)
        }
    }

    // ---- context menu ----
    async buildContextMenu (item: SFTPFile): Promise<MenuItemOptions[]> {
        let items: MenuItemOptions[] = []
        for (const section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(item, this as any)))) {
            items.push({ type: 'separator' })
            items = items.concat(section)
        }
        items = items.slice(1)
        // Drop Tabby's built-in "Edit locally" (it ignores our configured editor); add our own.
        // translate.instant gives the current-locale string, so this matches regardless of language.
        items = items.filter(i => i.label !== this.translate.instant('Edit locally'))
        if (!item.isDirectory) {
            // Primary actions grouped at the very top: Open, then (when a configured editor is
            // active) the OS-default-app override directly beneath it.
            const top: MenuItemOptions[] = [{ label: this.translate.instant('Open'), click: () => this.editFile(item, item.mode, item.size) }]
            if (this.config.store.sftpPanel.editorEnabled) {
                top.push({ label: this.translate.instant('Open with default app'), click: () => this.openWithDefault(item, item.mode, item.size) })
            }
            top.push({ type: 'separator' })
            items.unshift(...top)
        }
        items.push({ type: 'separator' })
        items.push({ label: this.translate.instant('Rename…'), click: () => this.renameItem(item) })
        items.push({ label: this.translate.instant('Copy / Move…'), click: () => this.copyMoveSelected(item) })
        items.push({ label: this.translate.instant('Copy path'), click: () => this.copyPath(item) })
        items.push({ label: this.translate.instant('Permissions…'), click: () => this.openChmodDialog(item) })
        // Collapse any adjacent or trailing separators (filtering Tabby's item can strand one).
        const cleaned: MenuItemOptions[] = []
        for (const it of items) {
            if (it.type === 'separator' && (cleaned.length === 0 || cleaned[cleaned.length - 1].type === 'separator')) { continue }
            cleaned.push(it)
        }
        while (cleaned.length && cleaned[cleaned.length - 1].type === 'separator') { cleaned.pop() }
        return cleaned
    }
    async showContextMenu (item: SFTPFile, event: MouseEvent): Promise<void> {
        event.preventDefault()
        event.stopPropagation()   // don't bubble to the blank-area folder menu on .sp-body
        if (!this.selection.has(item.fullPath)) { this.selection.clear(); this.selection.add(item.fullPath); this.lastIndex = this.viewList.indexOf(item) }
        this.platform.popupContextMenu(await this.buildContextMenu(item), event)
    }

    // Right-click on empty file-list space → menu acting on the CURRENT folder.
    async showFolderContextMenu (event: MouseEvent): Promise<void> {
        if (!this.sftp || this.fileList === null) { return }
        event.preventDefault()
        const items: MenuItemOptions[] = [
            { label: this.translate.instant('Create file…'), click: () => this.openCreateFileModal() },
            { label: this.translate.instant('Create directory…'), click: () => this.openCreateDirectoryModal() },
            { type: 'separator' },
            { label: this.translate.instant('Copy path'), click: () => navigator.clipboard.writeText(this.path).catch(() => this.log.log('warn', this.translate.instant('Copy failed'))) },
            { label: this.translate.instant('Permissions…'), click: () => this.openFolderChmod() },
        ]
        this.platform.popupContextMenu(items, event)
    }

    private async openFolderChmod (): Promise<void> {
        try {
            // russh's stat() returns permissions=0 on some servers (→ 000 in the dialog),
            // while readdir carries the real mode — it's what the file rows show. So read the
            // folder's own mode from its PARENT listing, the same reliable source as the rows.
            // ponytail: root ("/") has no parent → fall back to stat (chmod on / is a non-case).
            const parent = path.dirname(this.path)
            let f = parent !== this.path
                ? folderEntryFromParent(this.path, await this.sftp.readdir(parent))
                : null
            if (!f) {
                f = await this.sftp.stat(this.path)
                f.fullPath = this.path
                f.name = path.basename(this.path) || this.path
            }
            await this.openChmodDialog(f)
        } catch (e: any) {
            this.log.log('error', this.translate.instant('Could not read folder permissions'), e?.message ?? String(e))
        }
    }

    // ---- create dir / upload / download (reused from Tabby's original) ----
    async openCreateDirectoryModal (): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = this.translate.instant('New directory name')
        const result = await modal.result.catch(() => null)
        const name = result?.value
        if (name?.trim()) {
            this.sftp.mkdir(path.join(this.path, name))
                .then(() => { this.log.log('info', this.translate.instant('Directory created')); this.navigate(path.join(this.path, name)) })
                .catch(() => this.log.log('error', this.translate.instant('Could not create directory')))
        }
    }
    async openCreateFileModal (): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = this.translate.instant('New file name')
        const result = await modal.result.catch(() => null)
        const name = result?.value?.trim()
        if (!name) { return }
        try {
            // russh's OPEN_* flags live in its native binary; get the running module
            // via Electron's node require (russh isn't webpack-external here, and the
            // plugin has no own copy — see the window.require notes in project memory).
            const russh = (window as any).require('russh')
            const handle = await this.sftp.open(path.join(this.path, name), russh.OPEN_WRITE | russh.OPEN_CREATE)
            await handle.close()
            this.log.log('info', this.translate.instant('File created: {name}', { name }))
            await this.navigate(this.path)
            const created = path.join(this.path, name)
            if (this.viewList.some(i => i.fullPath === created)) {
                this.selection.clear(); this.selection.add(created)
                this.lastIndex = this.viewList.findIndex(i => i.fullPath === created)
                this.cdr.detectChanges()
            }
        } catch (e: any) {
            this.log.log('error', this.translate.instant('Could not create file: {name}', { name }), e?.message ?? String(e))
        }
    }

    async renameItem (item: SFTPFile): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = this.translate.instant('Rename to')
        modal.componentInstance.value = item.name
        const result = await modal.result.catch(() => null)
        const name = result?.value?.trim()
        if (!name || name === item.name) { return }
        const target = path.join(path.dirname(item.fullPath), name)
        try {
            await this.sftp.rename(item.fullPath, target)
            this.log.log('info', this.translate.instant('Renamed {old} → {new}', { old: item.name, new: name }))
            await this.navigate(this.path)
            if (this.viewList.some(i => i.fullPath === target)) {
                this.selection.clear(); this.selection.add(target)
                this.lastIndex = this.viewList.findIndex(i => i.fullPath === target)
                this.cdr.detectChanges()
            }
        } catch (e: any) {
            this.log.log('error', this.translate.instant('Rename failed: {name}', { name: item.name }), e?.message ?? String(e))
        }
    }

    copyPath (item: SFTPFile): void {
        // Copy the whole selection if the clicked row is part of it, else just this row.
        const selected = this.selectedItems()
        const targets = selected.some(i => i.fullPath === item.fullPath) && selected.length > 1 ? selected : [item]
        navigator.clipboard.writeText(targets.map(i => i.fullPath).join('\n'))
            .catch(() => this.log.log('warn', this.translate.instant('Copy failed')))
    }

    // Copy or move the selected items to a destination dir on the SAME server session.
    // Move = per-item sftp.rename(); copy = one `cp -r` over exec (SFTP has no server-side copy).
    async copyMoveSelected (item: SFTPFile): Promise<void> {
        const selected = this.selectedItems()
        const targets = selected.some(i => i.fullPath === item.fullPath) && selected.length > 1
            ? selected
            : [item]
        const modal = this.ngbModal.open(CopyMoveDialogComponent)
        const inst = modal.componentInstance as CopyMoveDialogComponent
        inst.itemCount = targets.length
        inst.dest = this.path
        const result = await modal.result.catch(() => null) as { dest: string, op: 'copy' | 'move' } | null
        if (!result) { return }
        const dest = result.dest.trim()
        if (!dest) { return }
        if (result.op === 'move') {
            await this.applyServerMove(targets, dest)
        } else {
            await this.applyServerCopy(targets, dest)
        }
        // A move always removes rows from the current folder; a copy only changes it when dest is here.
        if (result.op === 'move' || dest === this.path) { await this.navigate(this.path) }
    }

    private async applyServerMove (targets: SFTPFile[], dest: string): Promise<void> {
        const failures: string[] = []
        for (const t of targets) {
            const target = path.join(dest, path.basename(t.fullPath))
            try {
                await this.sftp.rename(t.fullPath, target)
            } catch (e: any) {
                // ponytail: rename only; cross-mount move fails with EXDEV — reported, not silently cp+rm.
                failures.push(`${t.fullPath}: ${describeSftpError(e)}`)
            }
        }
        if (failures.length > 0) {
            this.log.log('error', this.translate.instant('Move failed on {n} item(s)', { n: failures.length }), failures.join('\n'))
        } else {
            this.log.log('info', this.translate.instant('Moved {n} item(s) to {dest}', { n: targets.length, dest }))
        }
    }

    private async applyServerCopy (targets: SFTPFile[], dest: string): Promise<void> {
        // No timeout (0) — cp -r on a big tree can outlast the default 5s exec cap.
        const out = await this.exec(buildCpCommand(targets.map(t => t.fullPath), dest), 0)
        if (out === null) {
            this.log.log('error', this.translate.instant('Copy failed'), 'exec failed')
        } else if (out.trim() !== '') {
            this.log.log('error', this.translate.instant('Copy failed'), out.trim())
        } else {
            this.log.log('info', this.translate.instant('Copied {n} item(s) to {dest}', { n: targets.length, dest }))
        }
    }

    // Drag a row out to Explorer = download. HTML5 drag can't carry a not-yet-local file,
    // so: cancel it, pull the file(s) to a temp dir (shown as transfers in the panel log),
    // then hand Explorer a native OS drag via Electron's webContents.startDrag.
    // Big files: if the download outlives the mouse gesture, the fetched file is cached —
    // the log says "drag again" and the second drag starts instantly from the cache.
    // ---- drag-out (one drag for any file/folder/selection) ----
    // Windows serves DownloadURL drag-out through the SHELL (Explorer pulls the URL
    // stream and writes the dropped file itself — Chromium never learns the drop
    // path, will-download never fires). So:
    //  - single file: the URL serves the REAL bytes; the shell writes the whole
    //    file on drop. Done in one drag.
    //  - folders/multi-select (one URL = one file): the URL serves a 0-byte marker
    //    with a unique token name; the shell drops it in the target folder and we
    //    FIND it (open Explorer windows via Shell COM + Desktop + Downloads, one
    //    subdir level deep), delete it, and SFTP-download the payload right there.
    //    If the marker can't be found, deliver to ~/Downloads and say so.
    private dragServer: any = null
    private dragPort = 0
    private dragFiles = new Map<string, SFTPFile>()      // /file/<token> → stream real bytes
    private dragMarkers = new Map<string, SFTPFile[]>()  // /marker/<token> → locate + deliver

    private startDragServer (): void {
        try {
            const http = (window as any).require('http')
            // 127.0.0.1 only, random one-shot tokens, dies with the panel.
            this.dragServer = http.createServer((request: any, res: any) => this.serveDragOut(request, res))
            this.dragServer.listen(0, '127.0.0.1', () => { this.dragPort = this.dragServer.address().port })
        } catch (e: any) {
            this.dragPort = 0
            this.log.log('warn', this.translate.instant('Drag-out unavailable'), e?.message ?? String(e))
        }
    }

    private async serveDragOut (request: any, res: any): Promise<void> {
        const url: string = request.url ?? ''
        if (url.startsWith('/file/')) {
            const item = this.dragFiles.get(url.slice(6))
            if (!item || !this.sftp) { res.statusCode = 404; res.end(); return }
            this.dragFiles.clear() // one-shot
            res.setHeader('Content-Type', 'application/octet-stream')
            res.setHeader('Content-Length', item.size)
            const transfer = new StreamDownload(res, item.name, item.mode, item.size)
            res.on('close', () => { if (!transfer.isComplete()) { transfer.cancel() } })
            ;(this.platform as any).fileTransferStarted.next(transfer)
            this.log.setRemotePath(transfer, item.fullPath)
            try {
                await this.sftp.download(item.fullPath, transfer)
            } catch {
                try { res.destroy() } catch { /* gone */ }
            }
            return
        }
        if (url.startsWith('/marker/')) {
            const token = url.slice(8)
            const targets = this.dragMarkers.get(token)
            res.setHeader('Content-Length', 0)
            res.statusCode = targets ? 200 : 404
            res.end()
            if (!targets) { return }
            this.dragMarkers.clear() // one-shot; the request means the drop happened
            const dir = await this.locateDropFolder(`${token}.tabbydrop`)
            if (!dir) { this.log.log('warn', this.translate.instant('Drop folder not found — saving to Downloads')) }
            await this.deliverDragOut(dir ?? this.downloadsDir(), targets)
            return
        }
        res.statusCode = 404
        res.end()
    }

    private downloadsDir (): string {
        const req = (window as any).require
        return req('path').join(req('os').homedir(), 'Downloads')
    }

    // The shell wrote our uniquely-named marker into the drop folder — sweep the
    // plausible drop targets for it: every open Explorer window (Shell COM via
    // PowerShell), Desktop, Downloads, plus one subdir level of each (drops onto a
    // folder ICON inside a window land there). Poll a few seconds, delete on find.
    private async locateDropFolder (marker: string): Promise<string | null> {
        const req = (window as any).require
        const fs = req('fs'), nodePath = req('path'), os = req('os')
        const { execFile } = req('child_process')
        const explorerDirs: string[] = await new Promise(resolve => {
            execFile('powershell', ['-NoProfile', '-Command',
                "[Environment]::GetFolderPath('Desktop'); (New-Object -ComObject Shell.Application).Windows() | ForEach-Object { try { $_.Document.Folder.Self.Path } catch {} }"],
            { windowsHide: true, timeout: 10000 }, (_err: any, stdout: string) => {
                resolve(String(stdout ?? '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('::')))
            })
        })
        const candidates = new Set<string>([this.downloadsDir(), nodePath.join(os.homedir(), 'Desktop'), ...explorerDirs])
        for (const root of [...candidates]) {
            try {
                for (const d of fs.readdirSync(root, { withFileTypes: true })) {
                    if (d.isDirectory()) { candidates.add(nodePath.join(root, d.name)) }
                }
            } catch { /* unreadable root */ }
        }
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
            for (const dir of candidates) {
                const p = nodePath.join(dir, marker)
                if (fs.existsSync(p)) {
                    try { fs.unlinkSync(p) } catch { /* locked — still the right folder */ }
                    return dir
                }
            }
            await new Promise(r => setTimeout(r, 300))
        }
        return null
    }

    private async deliverDragOut (dir: string, targets: SFTPFile[]): Promise<void> {
        const req = (window as any).require
        const fs = req('fs'), nodePath = req('path')
        try {
            for (const t of targets) {
                const local = this.uniquePath(fs, nodePath, dir, t.name)
                if (t.isDirectory) {
                    // One aggregate log entry per tree: size pass first for a real total,
                    // then every file streams through it (progress bar + cancel work).
                    const agg = new FolderDragOutDownload(t.name)
                    agg.setTotal(await this.treeSize(t))
                    // Protected subject on PlatformService — feeding it routes the transfer
                    // through the same pipeline as Tabby's own (log entry, auto-show, polling).
                    ;(this.platform as any).fileTransferStarted.next(agg)
                    this.log.setRemotePath(agg, t.fullPath)
                    await this.downloadTree(t, local, fs, nodePath, agg)
                    agg.finish()
                } else {
                    const transfer = new DragOutDownload(fs, local, t.name, t.mode, t.size)
                    ;(this.platform as any).fileTransferStarted.next(transfer)
                    this.log.setRemotePath(transfer, t.fullPath)
                    await this.sftp.download(t.fullPath, transfer)
                }
            }
        } catch (e: any) {
            // 'Cancelled' = user hit the X on the transfer — not an error.
            if (e?.message !== 'Cancelled') { this.log.log('error', this.translate.instant('Drag-out failed'), e?.message ?? String(e)) }
        }
    }

    // Explorer-style collision handling: never overwrite, append " (2)", " (3)", …
    private uniquePath (fs: any, nodePath: any, dir: string, name: string): string {
        let p = nodePath.join(dir, name)
        if (!fs.existsSync(p)) { return p }
        const ext = nodePath.extname(name)
        const base = name.slice(0, name.length - ext.length)
        for (let n = 2; ; n++) {
            p = nodePath.join(dir, `${base} (${n})${ext}`)
            if (!fs.existsSync(p)) { return p }
        }
    }
    onDragOut (item: SFTPFile, event: DragEvent): void {
        if (!this.dragPort || !event.dataTransfer) { event.preventDefault(); return }
        const selected = this.selectedItems()
        const targets = selected.some(i => i.fullPath === item.fullPath) && selected.length > 1 ? selected : [item]
        this.dragFiles.clear(); this.dragMarkers.clear() // one drag at a time; drop stale tokens
        const token = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('')
        event.dataTransfer.effectAllowed = 'copy'
        if (targets.length === 1 && !targets[0].isDirectory) {
            // Real bytes on the drag itself — the shell writes the file on drop.
            this.dragFiles.set(token, targets[0])
            const name = targets[0].name.replace(/[:%\\/]/g, '_') // ':' is the DownloadURL field separator
            event.dataTransfer.setData('DownloadURL', `application/octet-stream:${name}:http://127.0.0.1:${this.dragPort}/file/${token}`)
        } else {
            // Folders/multi: unique 0-byte marker; we locate it after the drop and
            // deliver the payload next to it.
            this.dragMarkers.set(token, targets)
            event.dataTransfer.setData('DownloadURL', `application/octet-stream:${token}.tabbydrop:http://127.0.0.1:${this.dragPort}/marker/${token}`)
        }
    }

    // Sum a remote tree's file bytes. onStep (optional) fires after each item with the
    // running frame total — the menu folder-download feeds it to transfer.setTotalSize.
    private async treeSize (folder: SFTPFile, onStep?: (running: number) => void): Promise<number> {
        let total = 0
        for (const item of await this.sftp.readdir(folder.fullPath)) {
            total += item.isDirectory ? await this.treeSize(item, onStep) : item.size
            onStep?.(total)
        }
        return total
    }

    // Mirror a remote tree into a local dir; every file forwards its chunks
    // to the aggregate transfer (which also aborts the walk when cancelled).
    private async downloadTree (folder: SFTPFile, localDir: string, fs: any, nodePath: any, agg: FolderDragOutDownload): Promise<void> {
        fs.mkdirSync(localDir, { recursive: true })
        for (const item of await this.sftp.readdir(folder.fullPath)) {
            const local = nodePath.join(localDir, item.name)
            if (item.isDirectory) {
                await this.downloadTree(item, local, fs, nodePath, agg)
            } else {
                await this.sftp.download(item.fullPath, new DragOutDownload(fs, local, item.name, item.mode, item.size, n => agg.bump(n)))
            }
        }
    }

    async upload (): Promise<void> {
        await this.uploadFiles(await this.platform.startUpload({ multiple: true }))
    }
    // Upload a flat set of files, prompting per existing target.
    private async uploadFiles (transfers: FileUpload[]): Promise<void> {
        const keep = await this.resolveCollisions(transfers, t => path.join(this.path, t.getName()))
        for (const t of transfers) { if (!keep.includes(t)) { this.log.dropTransfers([t]) } } // skipped rows
        await Promise.all(keep.map(t => this.uploadOne(t)))
    }
    private async exists (p: string): Promise<boolean> {
        try { await this.sftp.stat(p); return true } catch { return false }
    }
    // Stat every target (parallel); for each existing one ask Overwrite / Overwrite all
    // / Skip / Skip all — the "all" buttons appear only while more conflicts remain and
    // apply the choice to the rest without further prompts. Returns the items to upload.
    private async resolveCollisions<T> (items: T[], targetOf: (t: T) => string): Promise<T[]> {
        const flags = await Promise.all(items.map(it => this.exists(targetOf(it))))
        const conflicts = items.filter((_, i) => flags[i])
        if (!conflicts.length) { return items }
        const skip = new Set<T>()
        let applyAll: 'overwrite' | 'skip' | null = null
        for (let i = 0; i < conflicts.length; i++) {
            const it = conflicts[i]
            if (applyAll) { if (applyAll === 'skip') { skip.add(it) } continue }
            const more = i < conflicts.length - 1
            // keys drive the switch below; buttons are their translated display labels (same order).
            const keys = ['Overwrite', ...(more ? ['Overwrite all'] : []), 'Skip', ...(more ? ['Skip all'] : [])]
            const buttons = keys.map(k => this.translate.instant(k))
            const res = await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant('{target} already exists on the server.', { target: targetOf(it) }),
                buttons, defaultId: 0, cancelId: keys.indexOf('Skip'),
            })
            switch (keys[res.response]) {
                case 'Overwrite all': applyAll = 'overwrite'; break
                case 'Skip all': applyAll = 'skip'; skip.add(it); break
                case 'Skip': skip.add(it); break
                // 'Overwrite' → keep (nothing to do)
            }
        }
        this.focusBody()
        return items.filter(it => !skip.has(it))
    }
    async uploadFolder (): Promise<void> {
        // Capture across discovery so Tabby's per-file rows never flash before the aggregate.
        this.log.beginCapture()
        let root: DirectoryUpload
        try { root = await this.platform.startUploadDirectory() } finally { this.log.endCapture() }
        await this.uploadOneFolder(root)
    }
    // dragover must preventDefault or the browser never fires drop.
    onDropZoneOver (ev: DragEvent): void { ev.preventDefault() }
    // Folder/file drop: replaces Tabby's dropZone directive so we can capture the emit
    // stream (see LogService.beginCapture) around the drag traversal, which otherwise
    // paints one row per descendant file before our aggregate row appears.
    async onDrop (ev: DragEvent): Promise<void> {
        ev.preventDefault()
        this.log.beginCapture()
        let root: DirectoryUpload
        try { root = await this.platform.startUploadFromDragEvent(ev, true) } finally { this.log.endCapture() }
        await this.uploadOneFolder(root)
    }
    async uploadOneFolder (root: DirectoryUpload): Promise<void> {
        const saved = this.path
        // Both the dialog and drag give an UNNAMED root DirectoryUpload; the real
        // folder(s) are its DirectoryUpload children. Loose files (no folder dropped)
        // → keep normal per-file rows, one each (so name shows + cancel works).
        const dirs = root.getChildrens().filter((c): c is DirectoryUpload => c instanceof DirectoryUpload)
        if (!dirs.length) {
            this.log.endScan()   // loose files get their own per-file rows below
            await this.uploadFiles(root.getChildrens() as FileUpload[])
            return
        }
        // Real folder(s): fold into one aggregate row named after the folder.
        const all: { up: FileUpload, rel: string }[] = []
        const walk = (d: DirectoryUpload, accum: string): void => {
            for (const t of d.getChildrens()) {
                if (t instanceof DirectoryUpload) { walk(t, path.posix.join(accum, t.getName())) }
                else { all.push({ up: t, rel: accum }) }
            }
        }
        walk(root, '')
        if (!all.length) { this.log.endScan(); return }
        const name = dirs.map(d => d.getName()).join(', ')

        // Child rows never entered the log (captured during discovery) — the live scan row
        // covers the wait. Stat can be slow for many files, so relabel it. Prompt per existing target.
        this.log.setScanText(this.translate.instant('Checking existing files…'))
        const files = await this.resolveCollisions(all, f => path.posix.join(this.path, f.rel, f.up.getName()))
        if (!files.length) { this.log.endScan(); return }
        const agg = new FolderUpload(name)
        agg.setTotal(files.reduce((s, f) => s + f.up.getSize(), 0))
        const entry = this.log.addTransfer(agg, true)
        this.log.endScan()   // aggregate row is now up — retire the scan row
        this.log.setRemotePath(agg, path.posix.join(this.path, dirs.length === 1 ? dirs[0].getName() : ''))

        // Pre-create every directory (incl. intermediate ones with no direct files),
        // parents before children.
        for (const d of expandDirs(files.map(f => f.rel))) {
            try { await this.sftp.mkdir(path.posix.join(this.path, d)) } catch { /* dup dir */ }
        }

        try {
            for (const f of files) {
                if (agg.isCancelled()) { break }
                agg.setCurrent(f.rel ? path.posix.join(f.rel, f.up.getName()) : f.up.getName())
                this.log.update(entry, agg.label())
                await this.sftp.upload(path.posix.join(this.path, f.rel, f.up.getName()), new ChildUpload(f.up, agg))
            }
            agg.finish()
        } catch { /* cancelled or failed mid-tree — row state (X) reflects it */ }
        // Final row = plain folder name (drop the per-file "folder — file" label).
        this.log.update(entry, name)
        if (this.path === saved) { await this.navigate(this.path) }
    }
    async uploadOne (transfer: FileUpload): Promise<void> {
        const saved = this.path
        const remote = path.join(this.path, transfer.getName())
        const up = new CancelUpload(transfer)
        this.log.swapTransfer(transfer, up)
        this.log.setRemotePath(up, remote)
        try { await this.sftp.upload(remote, up) } catch { /* stopped/failed — row X reflects it */ }
        if (this.path === saved) { await this.navigate(this.path) }
    }
    async download (itemPath: string, mode: number, size: number): Promise<void> {
        const transfer = await this.platform.startDownload(path.basename(itemPath), mode, size)
        if (!transfer) { return }
        const dl = new CancelDownload(transfer)
        this.log.swapTransfer(transfer, dl)
        this.log.setRemotePath(dl, itemPath)
        this.sftp.download(itemPath, dl).catch(() => { /* stopped/failed — row X reflects it */ })
    }
    // Called by name at runtime from tabby-ssh's CommonSFTPContextMenu ("Download"
    // item for files) — invisible to static grep, do NOT delete as dead code.
    async downloadItem (item: SFTPFile): Promise<void> {
        if (item.isDirectory) { await this.downloadFolder(item); return }
        if (item.isSymlink) {
            const target = path.resolve(this.path, await this.sftp.readlink(item.fullPath))
            const stat = await this.sftp.stat(target)
            if (stat.isDirectory) { await this.downloadFolder(item); return }
            await this.download(item.fullPath, stat.mode, stat.size); return
        }
        await this.download(item.fullPath, item.mode, item.size)
    }
    async downloadFolder (folder: SFTPFile): Promise<void> {
        try {
            // startDownloadDirectory is implemented by tabby-electron's concrete PlatformService at
            // runtime (like "Edit locally", it lives outside tabby-core/tabby-ssh) and isn't declared
            // on the abstract PlatformService typings here — cast through `any`.
            const transfer = await (this.platform as any).startDownloadDirectory(folder.name, 0)
            if (!transfer) { return }
            try {
                await Promise.all([this.treeSize(folder, t => transfer.setTotalSize(t)), this.downloadRecursive(folder, transfer, '')])
                transfer.setStatus(''); transfer.setCompleted(true)
            } catch (e) { transfer.cancel(); throw e } finally { transfer.close() }
        } catch (e: any) {
            this.log.log('error', this.translate.instant('Download folder failed: {name}', { name: folder.name }), e.message)
        }
    }
    private async downloadRecursive (folder: SFTPFile, transfer: any, rel: string): Promise<void> {
        for (const item of await this.sftp.readdir(folder.fullPath)) {
            if (transfer.isCancelled()) { throw new Error('Download cancelled') }
            const r = rel ? `${rel}/${item.name}` : item.name
            transfer.setStatus(r)
            if (item.isDirectory) { await transfer.createDirectory(r); await this.downloadRecursive(item, transfer, r) } else {
                const fd = await transfer.createFile(r, item.mode, item.size)
                await this.sftp.download(item.fullPath, fd)
            }
        }
    }

    // ---- bulk ----
    async downloadSelected (): Promise<void> {
        for (const item of this.selectedItems()) {
            if (item.isDirectory) { await this.downloadFolder(item) } else { await this.download(item.fullPath, item.mode, item.size) }
        }
    }
    async deleteSelected (skipConfirm = false): Promise<void> {
        const items = this.selectedItems()
        // Shift+Delete bypasses the confirmation dialog.
        if (!skipConfirm) {
            const ok = await this.platform.showMessageBox({
                type: 'warning', message: this.translate.instant('Delete {n} item(s)?', { n: items.length }),
                buttons: [this.translate.instant('Delete'), this.translate.instant('Cancel')], defaultId: 1, cancelId: 1,
            })
            // Native dialog steals focus; hand it back to the list either way.
            this.focusBody()
            if (ok.response !== 0) { return }
        }
        for (const item of items) {
            // Live-updated log entry so a big tree visibly makes progress.
            const entry = this.log.log('info', this.translate.instant('Deleting {name}…', { name: item.name }))
            let count = 0
            try {
                await this.deleteRecursive(item, () => {
                    if (++count % 10 === 0) { this.log.update(entry, this.translate.instant('Deleting {name}… ({count} items)', { name: item.name, count })) }
                })
                this.log.update(entry, count > 1
                    ? this.translate.instant('Deleted {name} ({count} items)', { name: item.name, count })
                    : this.translate.instant('Deleted {name}', { name: item.name }))
            } catch (e: any) {
                this.log.update(entry, this.translate.instant('Delete failed: {name}', { name: item.name }))
                this.log.log('error', this.translate.instant('Delete failed: {name}', { name: item.name }), e?.message ?? String(e))
            }
        }
        await this.navigate(this.path)
        this.focusBody()
    }

    // rmdir only removes empty dirs (SFTP protocol) — walk the tree, files first,
    // dir itself last. Symlinks are unlinked, never followed (loop-safe, and a link
    // to a dir must not delete the target's contents).
    private async deleteRecursive (item: SFTPFile, onDeleted: () => void): Promise<void> {
        if (item.isDirectory && !item.isSymlink) {
            for (const child of await this.sftp.readdir(item.fullPath)) {
                await this.deleteRecursive(child, onDeleted)
            }
            await this.sftp.rmdir(item.fullPath)
        } else {
            await this.sftp.unlink(item.fullPath)
        }
        onDeleted()
    }

    private focusBody (): void {
        ;(this.host.nativeElement.querySelector('.sp-body') as HTMLElement | null)?.focus({ preventScroll: true })
    }

    async openChmodDialog (item: SFTPFile): Promise<void> {
        // Target set: the multi-selection if the clicked row is part of it, else just this row.
        const selected = this.selectedItems()
        const targets = selected.some(i => i.fullPath === item.fullPath) && selected.length > 1
            ? selected
            : [item]

        // chown needs root and only exists over exec (SFTP has none). Detect uid once, cache.
        if (this.isRoot === null) {
            const out = await this.exec('id -u')
            this.isRoot = out !== null && out.trim().split('\n').pop()?.trim() === '0'
        }
        // Fetch the server's user/group lists once (root only) to populate the dropdowns.
        if (this.isRoot && this.users === null) {
            const [pw, gr] = await Promise.all([
                this.exec('getent passwd 2>/dev/null || cat /etc/passwd'),
                this.exec('getent group 2>/dev/null || cat /etc/group'),
            ])
            this.users = parseNames(pw ?? '')
            this.groups = parseNames(gr ?? '')
        }

        const modal = this.ngbModal.open(ChmodDialogComponent)
        const inst = modal.componentInstance as ChmodDialogComponent
        inst.itemCount = targets.length
        inst.hasFolder = targets.some(t => t.isDirectory)
        inst.initialMode = item.mode & 0o777
        inst.showOwner = this.isRoot
        inst.users = this.users ?? []
        inst.groups = this.groups ?? []
        inst.owner = (item as any).owner ?? ''
        inst.group = (item as any).group ?? ''
        inst.seed()

        const result = await modal.result.catch(() => null) as
            { mode: number, recursive: boolean, chown?: { owner: string, group: string } } | null
        if (!result) { return }
        if (result.chown) { await this.applyChown(targets, result.chown, result.recursive) }
        await this.applyChmod(targets, result.mode, result.recursive)
    }

    // chown via exec (SFTP has no chown/setstat; only route is the shell, which needs root —
    // gated by isRoot). `2>&1` folds stderr into stdout so a failure (empty stdout otherwise)
    // shows up as non-empty output. `-R` recurses server-side, no JS walk needed.
    private async applyChown (targets: SFTPFile[], chown: { owner: string, group: string }, recursive: boolean): Promise<void> {
        const spec = chown.group ? `${chown.owner}:${chown.group}` : chown.owner
        const flag = recursive ? '-R ' : ''
        // `chown -R` recurses server-side in one blocking exec — no per-file callback to count,
        // so just show an indeterminate "working…" row (ticking targets) so the user knows a
        // slow recursive change is in flight.
        const total = targets.length
        const entry = this.log.log('info', this.translate.instant('Changing ownership… ({done}/{total})', { done: 0, total }))
        const failures: string[] = []
        let done = 0
        for (const t of targets) {
            const out = await this.exec(`chown ${flag}${spec} ${shQuote(t.fullPath)} 2>&1`)
            if (out === null) { failures.push(`${t.fullPath}: exec failed`) } else if (out.trim() !== '') { failures.push(`${t.fullPath}: ${out.trim()}`) }
            this.log.update(entry, this.translate.instant('Changing ownership… ({done}/{total})', { done: ++done, total }))
        }
        if (failures.length > 0) {
            this.log.remove(entry)
            this.log.log('error', this.translate.instant('chown failed on {n} item(s)', { n: failures.length }), failures.join('\n'))
        } else {
            this.log.update(entry, this.translate.instant('Ownership updated'))
        }
    }

    private async applyChmod (targets: SFTPFile[], mode: number, recursive: boolean): Promise<void> {
        // Row up front: on a big recursive tree even building the path list (the readdir walk)
        // is slow, so show "Scanning folder…" BEFORE it and tick as descendants are discovered —
        // otherwise the panel looks frozen until the whole tree is collected.
        const entry = this.log.log('info', this.translate.instant('Scanning folder… ({count})', { count: 0 }))
        // Stop button on the row flips this; the scan callback and the chmod loop both check it
        // so the user can bail mid-scan (huge tree) or mid-apply. onCancel is cleared on exit.
        let cancelled = false
        entry.onCancel = () => { cancelled = true }
        // sequential chmod, O(n) calls — fine for normal trees; batch/parallelise only if large trees prove slow.
        const paths: string[] = []
        let scanned = 0
        try {
            for (const t of targets) {
                paths.push(t.fullPath)
                if (recursive && t.isDirectory && !t.isSymlink) {
                    paths.push(...await this.collectDescendants(t.fullPath, () => {
                        if (cancelled) { throw CANCELLED }
                        if (++scanned % 50 === 0) { this.log.update(entry, this.translate.instant('Scanning folder… ({count})', { count: scanned })) }
                    }))
                }
            }
        } catch (e) {
            if (e !== CANCELLED) { throw e }
            entry.onCancel = undefined
            this.log.update(entry, this.translate.instant('Cancelled'))   // nothing applied yet during scan
            return
        }
        // chmod deepest-first (children before parents). collectDescendants
        // pushes top-down, so reverse here — otherwise a mode that clears dir execute
        // (e.g. 700/644) locks out traversal into already-collected children before
        // we get to them, i.e. we'd revoke our own walking rights mid-walk.
        paths.reverse()
        // russh's native chmod applies the mode server-side but still throws a bare
        // SSH_FX_FAILURE on DIRECTORIES (russh-binary quirk, works on files) — so a caught
        // error isn't proof of failure. Stash suspects and verify them AFTER every chmod has
        // run, against a fresh directory listing (the same readdir the panel trusts). Verifying
        // in a second pass is what makes the per-parent cache safe: if we listed a parent while
        // some of its dir-children were still un-chmod'd, the snapshot would show their OLD mode
        // and we'd flag them as false failures.
        // Reuse the scan row for the chmod counter now that the walk is done.
        const total = paths.length
        this.log.update(entry, this.translate.instant('Changing permissions… ({done}/{total})', { done: 0, total }))
        const suspects: { p: string, err: string }[] = []
        let done = 0
        for (const p of paths) {
            if (cancelled) { break }
            try {
                await this.sftp.chmod(p, mode)
            } catch (e: any) {
                suspects.push({ p, err: describeSftpError(e) })
            }
            if (++done % 10 === 0 || done === total) {
                this.log.update(entry, this.translate.instant('Changing permissions… ({done}/{total})', { done, total }))
            }
        }
        entry.onCancel = undefined   // past the cancellable phases
        if (cancelled) {
            // Partial: some items already changed. Report as cancelled with the count applied.
            this.log.update(entry, this.translate.instant('Cancelled — {done}/{total} changed', { done, total }))
            await this.navigate(this.path)
            return
        }
        const listCache = new Map<string, Map<string, number>>()
        const modeApplied = async (p: string): Promise<boolean> => {
            const parent = path.dirname(p)
            let byName = listCache.get(parent)
            if (!byName) {
                try {
                    const entries = await this.sftp.readdir(parent)
                    byName = new Map(entries.map(e => [e.name, e.mode & 0o777]))
                } catch { byName = new Map() }
                listCache.set(parent, byName)
            }
            return byName.get(path.basename(p)) === (mode & 0o777)
        }
        const failures: string[] = []
        for (const s of suspects) {
            if (!await modeApplied(s.p)) { failures.push(`${s.p}: ${s.err}`) }
        }
        if (failures.length > 0) {
            this.log.remove(entry)
            this.log.log('error', this.translate.instant('chmod failed on {n} item(s)', { n: failures.length }), failures.join('\n'))
        } else {
            this.log.update(entry, this.translate.instant('Permissions updated'))
        }
        await this.navigate(this.path)   // refresh listing (clears selection)
    }

    // Recursively list every descendant path under `dir`. Symlinked dirs are not
    // descended (loop-safe); the symlink entry itself is still included by the caller.
    private async collectDescendants (dir: string, onProgress?: () => void): Promise<string[]> {
        const out: string[] = []
        let entries: SFTPFile[]
        try {
            entries = await this.sftp.readdir(dir)
        } catch {
            return out   // unreadable dir — skip its subtree, chmod on it already attempted by caller
        }
        for (const e of entries) {
            out.push(e.fullPath)
            onProgress?.()
            if (e.isDirectory && !e.isSymlink) {
                out.push(...await this.collectDescendants(e.fullPath, onProgress))
            }
        }
        return out
    }

    // ---- path edit / close ----
    editPath (): void { this.editingPath = this.path }
    confirmPath (): void { if (this.editingPath !== null) { this.navigate(this.editingPath); this.editingPath = null } }
}
