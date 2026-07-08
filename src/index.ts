import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ConfigProvider, ToolbarButtonProvider, HotkeyProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { SftpPanelConfigProvider } from './config'
import { SftpPanelComponent } from './panel.component'
import { SftpPanelHotkeyProvider, SftpPanelBootstrap } from './toolbar'
import { SftpPanelSettingsTabProvider, SftpPanelSettingsTabComponent } from './settings'
import { ChmodDialogComponent } from './chmod-dialog.component'
import { CopyMoveDialogComponent } from './copy-move-dialog.component'

@NgModule({
  imports: [CommonModule, FormsModule, NgbModule, TabbyCoreModule],
  providers: [
    { provide: ConfigProvider, useClass: SftpPanelConfigProvider, multi: true },
    { provide: SettingsTabProvider, useClass: SftpPanelSettingsTabProvider, multi: true },
    { provide: ToolbarButtonProvider, useClass: SftpPanelBootstrap, multi: true },
    { provide: HotkeyProvider, useClass: SftpPanelHotkeyProvider, multi: true },
  ],
  declarations: [SftpPanelComponent, SftpPanelSettingsTabComponent, ChmodDialogComponent, CopyMoveDialogComponent],
})
export default class SftpPanelModule { }
