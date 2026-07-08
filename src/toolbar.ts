import { Injectable } from '@angular/core'
import { ToolbarButtonProvider, ToolbarButton, HotkeysService, HotkeyDescription, HotkeyProvider } from 'tabby-core'
import { PanelMountService } from './mount.service'
import { SftpI18nService } from './i18n.service'

// Pure hotkey declaration. A HotkeyProvider must NOT inject HotkeysService — that's a
// circular dependency (HotkeysService collects HotkeyProviders) and yields a half-built
// instance whose hotkey$ is undefined. The subscription lives in the bootstrap below.
@Injectable()
export class SftpPanelHotkeyProvider extends HotkeyProvider {
    async provide (): Promise<HotkeyDescription[]> {
        return [{ id: 'toggle-sftp-panel', name: 'Focus SFTP Panel (reveal + file navigation)' }]
    }
}

// No visible button — the panel is a permanent edge strip on SSH tabs. This provider exists
// only to bootstrap the mount service (Tabby instantiates ToolbarButtonProviders after
// config + hotkeys are ready) and to wire the hotkey to pin/unpin.
@Injectable()
export class SftpPanelBootstrap extends ToolbarButtonProvider {
    // i18n is injected purely to force its eager construction (it merges our translations on init).
    constructor (private mount: PanelMountService, hotkeys: HotkeysService, _i18n: SftpI18nService) {
        super()
        hotkeys.hotkey$.subscribe(id => { if (id === 'toggle-sftp-panel') { this.mount.focusPanel() } })
    }

    provide (): ToolbarButton[] { return [] }
}
