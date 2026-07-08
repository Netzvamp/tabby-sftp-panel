import { Component, NgZone } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { LocalEditService } from './local-edit.service'

const req = (window as any).require

@Component({
  template: `
    <div class="form-line">
      <div class="header"><div class="title">{{ 'When you open a file (double-click)' | translate }}</div></div>
      <select class="form-control w-auto" [(ngModel)]="config.store.sftpPanel.fileClickAction" (ngModelChange)="config.save()">
        <option value="edit">{{ 'Edit locally' | translate }}</option>
        <option value="download">{{ 'Download' | translate }}</option>
      </select>
    </div>
    <div class="form-line">
      <div class="header">
        <div class="title">{{ 'Start folder' | translate }}</div>
        <div class="description">{{ 'Folder the panel opens on connect. Absolute path (e.g. /var/www), or ~ for your home directory.' | translate }}</div>
      </div>
      <input class="form-control w-auto" type="text" placeholder="~"
        [(ngModel)]="config.store.sftpPanel.startDirectory" (ngModelChange)="config.save()">
    </div>
    <div class="form-line">
      <div class="header">
        <div class="title">{{ 'Use a default editor for opening files' | translate }}</div>
        <div class="description">{{ 'Off: files open with the OS default app (normal Tabby behavior). On: pick one editor used for every file you open. Turning this on tries to auto-detect your editor (Windows only); you can also Browse or type the path. A blank path behaves like "off".' | translate }}</div>
      </div>
      <toggle [(ngModel)]="config.store.sftpPanel.editorEnabled" (ngModelChange)="onToggle()"></toggle>
    </div>
    <div class="form-line" *ngIf="config.store.sftpPanel.editorEnabled">
      <div class="header">
        <div class="title">{{ 'Editor path' | translate }}</div>
        <div class="description">{{ 'Executable used for every file you open. Blank = OS default app.' | translate }}</div>
      </div>
      <div class="d-flex align-items-center">
        <input class="form-control w-auto mr-2" type="text" [placeholder]="'(blank = OS default)' | translate"
          [(ngModel)]="config.store.sftpPanel.editorPath" (ngModelChange)="config.save()">
        <button class="btn btn-secondary" (click)="picker.click()">{{ 'Browse…' | translate }}</button>
        <input #picker type="file" class="d-none" (change)="onPicked($event)">
      </div>
    </div>
    <div class="form-line" *ngIf="config.store.sftpPanel.editorEnabled">
      <div class="header">
        <div class="title">{{ 'Warn when opening large files' | translate }}</div>
        <div class="description">{{ 'Show a confirmation before opening a file larger than this many MB in the editor (guards against mis-clicking a binary). 0 = never warn.' | translate }}</div>
      </div>
      <input class="form-control w-auto" type="number" min="0"
        [(ngModel)]="config.store.sftpPanel.editorMaxSizeMB" (ngModelChange)="config.save()">
    </div>
    <div class="form-line">
      <div class="header"><div class="title">{{ 'Panel side' | translate }}</div></div>
      <select class="form-control w-auto" [(ngModel)]="config.store.sftpPanel.side" (ngModelChange)="config.save()">
        <option value="left">{{ 'Left' | translate }}</option>
        <option value="right">{{ 'Right' | translate }}</option>
      </select>
    </div>
    <div class="form-line">
      <div class="header">
        <div class="title">{{ 'Show vertical label on collapsed strip' | translate }}</div>
        <div class="description">{{ 'The "SFTP Panel" text on the hover strip (unpinned). Off makes the strip thinner.' | translate }}</div>
      </div>
      <toggle [(ngModel)]="config.store.sftpPanel.spineLabel" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line">
      <div class="header">
        <div class="title">{{ 'Auto-show log on activity' | translate }}</div>
        <div class="description">{{ 'Reveals the log list at the bottom of the panel whenever a transfer starts or a message is logged. While the list is shown, the Tabby transfers popup is hidden.' | translate }}</div>
      </div>
      <toggle [(ngModel)]="config.store.sftpPanel.transfersAutoShow" (ngModelChange)="config.save()"></toggle>
    </div>
    <div class="form-line">
      <div class="header"><div class="title">{{ 'Toggle hotkey' | translate }}</div><div class="description">{{ 'Set under Settings → Hotkeys → "Focus SFTP Panel"' | translate }}</div></div>
    </div>
  `,
})
export class SftpPanelSettingsTabComponent {
  constructor (public config: ConfigService, private localEdit: LocalEditService, private zone: NgZone) {}

  // Turning the feature on: if no path yet, try to auto-detect one (Windows only). Blank stays blank.
  async onToggle (): Promise<void> {
    const cfg = this.config.store.sftpPanel
    if (cfg.editorEnabled && !(cfg.editorPath || '').trim()) {
      const exe = await this.localEdit.detectDefaultEditor()
      // detect resolves in a child_process callback = outside Angular's zone; re-enter it so the field updates.
      if (exe) { this.zone.run(() => { cfg.editorPath = exe; this.config.save() }); return }
    }
    this.config.save()
  }

  // Native file dialog via a hidden <input type=file>; read its absolute path (Electron).
  onPicked (ev: Event): void {
    const input = ev.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) {
      let p = (file as any).path as string   // Electron < 32 exposes File.path directly
      if (!p) { try { p = req('electron').webUtils.getPathForFile(file) } catch { p = '' } }  // Electron >= 32
      if (p) { this.config.store.sftpPanel.editorPath = p; this.config.save() }
    }
    input.value = ''   // reset so picking the same file again still fires change
  }
}

export class SftpPanelSettingsTabProvider extends SettingsTabProvider {
  id = 'sftp-panel'
  icon = 'folder-open'
  title = 'SFTP Panel'

  getComponentType (): any {
    return SftpPanelSettingsTabComponent
  }
}
