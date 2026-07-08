import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { octalToPerms, permsToOctal, Perms } from './sftp-util'

@Component({
    selector: 'chmod-dialog',
    template: `
    <div class="modal-header">
        <h5 class="modal-title">{{ 'Permissions' | translate }}{{ itemCount > 1 ? ' — ' + itemCount + ' ' + ('items' | translate) : '' }}</h5>
    </div>
    <div class="modal-body">
        <div class="cd-own" *ngIf="showOwner">
            <label>{{ 'Owner' | translate }}</label>
            <select class="form-control form-control-sm" [(ngModel)]="owner">
                <option *ngFor="let u of ownerOptions()" [value]="u">{{ u }}</option>
            </select>
            <label>{{ 'Group' | translate }}</label>
            <select class="form-control form-control-sm" [(ngModel)]="group">
                <option *ngFor="let g of groupOptions()" [value]="g">{{ g }}</option>
            </select>
        </div>
        <table class="cd-grid">
            <thead><tr><th></th><th>{{ 'Read' | translate }}</th><th>{{ 'Write' | translate }}</th><th>{{ 'Exec' | translate }}</th></tr></thead>
            <tbody>
                <tr *ngFor="let row of rows">
                    <th>{{ row.label | translate }}</th>
                    <td><input type="checkbox" [(ngModel)]="perms[row.key].r" (ngModelChange)="onGrid()"></td>
                    <td><input type="checkbox" [(ngModel)]="perms[row.key].w" (ngModelChange)="onGrid()"></td>
                    <td><input type="checkbox" [(ngModel)]="perms[row.key].x" (ngModelChange)="onGrid()"></td>
                </tr>
            </tbody>
        </table>
        <div class="cd-octal">
            <label>{{ 'Octal' | translate }}</label>
            <input type="text" [(ngModel)]="octalText" (ngModelChange)="onOctal()"
                   [class.cd-invalid]="!valid()" maxlength="4" spellcheck="false">
        </div>
        <label class="cd-rec" *ngIf="hasFolder">
            <input type="checkbox" [(ngModel)]="recursive"> {{ 'Apply recursively to folder contents' | translate }}
        </label>
        <p class="cd-warn">{{ 'The mode is applied literally to both files and folders.' | translate }}</p>
    </div>
    <div class="modal-footer">
        <button class="btn btn-secondary" (click)="activeModal.dismiss()">{{ 'Cancel' | translate }}</button>
        <button class="btn btn-primary" [disabled]="!valid()" (click)="ok()">OK</button>
    </div>
    `,
    styles: [`
        .modal-body { text-align: center; }
        .cd-own { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 14px; }
        .cd-own select { width: 140px; }
        .cd-grid { margin: 0 auto 12px; }
        .cd-grid th, .cd-grid td { text-align: center; padding: 4px 12px; }
        .cd-grid tbody th { text-align: left; }
        .cd-octal { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; }
        .cd-octal input { width: 80px; font-family: monospace; text-align: center; }
        .cd-invalid { border-color: #d33 !important; }
        .cd-rec { display: block; margin-bottom: 8px; }
        .cd-warn { opacity: .7; font-size: 12px; margin: 0; }
    `],
})
export class ChmodDialogComponent {
    itemCount = 1
    hasFolder = false
    initialMode = 0o644
    recursive = false
    octalText = '644'
    perms: Perms = octalToPerms(0o644)
    showOwner = false          // set true by opener when connected as root
    owner = ''
    group = ''
    users: string[] = []       // server user/group lists for the dropdowns
    groups: string[] = []
    private initOwner = ''
    private initGroup = ''

    // Ensure the file's current owner/group is selectable even if not in the fetched list.
    ownerOptions (): string[] { return this.owner && !this.users.includes(this.owner) ? [this.owner, ...this.users] : this.users }
    groupOptions (): string[] { return this.group && !this.groups.includes(this.group) ? [this.group, ...this.groups] : this.groups }
    rows = [
        { key: 'u' as const, label: 'Owner' },
        { key: 'g' as const, label: 'Group' },
        { key: 'o' as const, label: 'Other' },
    ]

    constructor (public activeModal: NgbActiveModal) { }

    // called by the opener after setting initialMode
    seed (): void {
        this.perms = octalToPerms(this.initialMode)
        this.octalText = permsToOctal(this.perms).toString(8).padStart(3, '0')
        this.initOwner = this.owner
        this.initGroup = this.group
    }

    onGrid (): void {
        this.octalText = permsToOctal(this.perms).toString(8).padStart(3, '0')
    }

    onOctal (): void {
        if (!this.valid()) { return }
        this.perms = octalToPerms(parseInt(this.octalText, 8))
    }

    valid (): boolean {
        return /^[0-7]{3,4}$/.test(this.octalText.trim())
    }

    ok (): void {
        if (!this.valid()) { return }
        // chown only when root, owner is set, and something actually changed.
        const chown = this.showOwner && this.owner.trim() && (this.owner !== this.initOwner || this.group !== this.initGroup)
            ? { owner: this.owner.trim(), group: this.group.trim() }
            : undefined
        this.activeModal.close({ mode: parseInt(this.octalText, 8) & 0o7777, recursive: this.recursive, chown })
    }
}
