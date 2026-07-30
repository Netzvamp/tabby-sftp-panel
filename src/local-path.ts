// The panel speaks posix paths everywhere (`panel.component.ts:1` imports `posix as path`),
// and posix.resolve() does not recognise `C:/` as a root: it prepends process.cwd() and
// returns garbage. So local paths are PRESENTED as virtual posix paths rooted at '/', and
// converted to native only at the fs boundary:
//     win32:  /C:/Users/x  <->  C:\Users\x     ('/' = the synthetic drive-list root)
//     posix:  /home/x      <->  /home/x        (identity, zero conversion)
// `win` is a parameter only so both flavours are testable from one machine.

export const isWin = process.platform === 'win32'

export function toNativePath (virtual: string, win = isWin): string {
    if (!win) { return virtual }
    const v = virtual.replace(/^\/+/, '').replace(/\//g, '\\')
    if (v === '') { return '\\' }
    // 'C:' alone is drive-relative on Windows — keep the root separator.
    return /^[A-Za-z]:$/.test(v) ? v + '\\' : v
}

/** `toNativePath` for anything about to be handed to `fs`. On win32 a virtual path that is
 *  not rooted at a drive (`/foo`, or a UNC path flattened by toVirtualPath) would come back
 *  RELATIVE — every `fs` call then resolves it against Tabby's own working directory and
 *  writes into the install folder. There is no correct native path to fall back on, so refuse
 *  loudly instead. Every fs boundary (LocalFsSession, local-ops) goes through this. */
export function toNativeFsPath (virtual: string, win = isWin): string {
    const native = toNativePath(virtual, win)
    if (win && !/^[A-Za-z]:[\\/]/.test(native)) {
        throw new Error(`${virtual} is not a path on any drive`)
    }
    return native
}

/** A drive-root row from the synthetic root listing ('/C:'). Navigable and nothing else:
 *  its basename is empty, so copy/move/delete would silently act on the WHOLE drive. */
export function isDriveRoot (p: string, win = isWin): boolean {
    return win && /^\/[A-Za-z]:\/?$/.test(p)
}

export function toVirtualPath (native: string, win = isWin): string {
    if (!win) { return native }
    const v = '/' + native.replace(/\\/g, '/').replace(/^\/+/, '')
    return v.length > 1 ? v.replace(/\/+$/, '') : v
}

/** True only for the synthetic win32 root whose listing is the drive list. */
export function isVirtualRoot (p: string, win = isWin): boolean {
    return win && /^\/+$/.test(p)
}

/** Drive roots as virtual paths, e.g. ['/C:', '/D:']. `exists` is injected so this is
 *  testable without touching a real filesystem. 26 probes, instant, and no dependency on
 *  the deprecated `wmic`. */
export function driveRoots (exists: (nativePath: string) => boolean): string[] {
    const out: string[] = []
    for (let c = 65; c <= 90; c++) {
        const letter = String.fromCharCode(c)
        if (exists(`${letter}:\\`)) { out.push(`/${letter}:`) }
    }
    return out
}
