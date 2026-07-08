import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

@Component({
    selector: 'copy-move-dialog',
    template: `
    <div class="modal-header">
        <h5 class="modal-title">{{ 'Copy / Move' | translate }}{{ itemCount > 1 ? ' — ' + itemCount + ' ' + ('items' | translate) : '' }}</h5>
    </div>
    <div class="modal-body">
        <label class="cm-label">{{ 'Destination directory' | translate }}</label>
        <input class="form-control form-control-sm" [(ngModel)]="dest" spellcheck="false" autofocus>
    </div>
    <div class="modal-footer">
        <button class="btn btn-secondary" (click)="activeModal.dismiss()">{{ 'Cancel' | translate }}</button>
        <button class="btn btn-primary" [disabled]="!dest.trim()" (click)="activeModal.close({ dest, op: 'copy' })">{{ 'Copy' | translate }}</button>
        <button class="btn btn-primary" [disabled]="!dest.trim()" (click)="activeModal.close({ dest, op: 'move' })">{{ 'Move' | translate }}</button>
    </div>
    `,
    styles: [`
        .cm-label { display: block; margin-bottom: 6px; }
        .modal-body input { font-family: monospace; }
    `],
})
export class CopyMoveDialogComponent {
    itemCount = 1
    dest = ''
    constructor (public activeModal: NgbActiveModal) {}
}
