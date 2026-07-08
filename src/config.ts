import { ConfigProvider } from 'tabby-core'

export class SftpPanelConfigProvider extends ConfigProvider {
    defaults = {
        // Declare the hotkey id so Tabby knows it at config-merge time and persists a
        // user-assigned binding across restarts.
        hotkeys: { 'toggle-sftp-panel': ['Ctrl-Shift-X'] },
        sftpPanel: {
            side: 'left',             // 'left' | 'right'
            pinned: false,            // true = docked (terminal shrinks) | false = edge strip that expands on hover
            spineLabel: true,         // show the vertical "SFTP Panel" label on the collapsed strip; off = thinner strip
            width: 420,               // panel width in px (expanded)
            startDirectory: '~',      // first-open folder: absolute path, or '~' for remote home
            showHidden: true,         // show dotfiles (toggle button in the panel header)
            fileClickAction: 'edit',  // 'edit' | 'download' (double-click a file)
            editorEnabled: false,     // master switch: off = normal Tabby behavior (OS default app)
            editorPath: '',           // editor exe used when enabled; blank while enabled = OS default too
            editorMaxSizeMB: 1,       // warn before opening a file larger than this in the editor; 0 = never
            transfersVisible: false,  // show the file-transfer list (persisted)
            transfersHeight: 160,     // file-transfer list height in px (persisted)
            transfersAutoShow: true,  // auto-show the list on a panel upload/download
            sort: { column: 'name', dir: 'asc' },  // column: 'name'|'size'|'modified'|'owner'|'group'
            columns: {
                name: { width: 240, visible: true },
                size: { width: 90, visible: true },
                modified: { width: 160, visible: true },
                owner: { width: 120, visible: true },
                group: { width: 120, visible: true },
                perms: { width: 110, visible: true },
            },
            columnOrder: ['name', 'size', 'modified', 'owner', 'group', 'perms'],  // drag headers to reorder
        },
    }
    platformDefaults = {}
}
