import * as C from 'constants'
import { posix } from 'path'
import type { SFTPFile } from 'tabby-ssh'

export type SortColumn = 'name' | 'size' | 'modified' | 'owner' | 'group'
export type SortDir = 'asc' | 'desc'

export function getFileType (fileExtension: string): string {
    const map: Record<string, string[]> = {
        code: ['js', 'ts', 'py', 'java', 'cpp', 'h', 'cs', 'html', 'css', 'rb', 'php', 'swift', 'go', 'kt', 'sh', 'json', 'cc', 'c', 'xml'],
        image: ['jpg', 'jpeg', 'png', 'gif', 'bmp'],
        pdf: ['pdf'],
        archive: ['zip', 'rar', 'tar', 'gz'],
        word: ['doc', 'docx'],
        video: ['mp4', 'avi', 'mkv', 'mov'],
        powerpoint: ['ppt', 'pptx'],
        text: ['txt', 'log'],
        audio: ['mp3', 'wav', 'flac'],
        excel: ['xls', 'xlsx'],
    }
    const ext = fileExtension.toLowerCase()
    for (const type of Object.keys(map)) {
        if (map[type].includes(ext)) { return type }
    }
    return 'unknown'
}

export function getIcon (item: SFTPFile): string {
    if (item.isDirectory) { return 'fas fa-folder text-info' }
    if (item.isSymlink) { return 'fas fa-link text-warning' }
    const m = /\.([^.]+)$/.exec(item.name)
    if (m) {
        const type = getFileType(m[1])
        return type === 'unknown' ? 'fas fa-file' : `fa-solid fa-file-${type} `
    }
    return 'fas fa-file'
}

export function getModeString (item: SFTPFile): string {
    const s = 'SGdrwxrwxrwx'
    const e = '   ---------'
    const c = [
        0o4000, 0o2000, C.S_IFDIR ?? 0o40000,
        C.S_IRUSR ?? 0o400, C.S_IWUSR ?? 0o200, C.S_IXUSR ?? 0o100,
        C.S_IRGRP ?? 0o040, C.S_IWGRP ?? 0o020, C.S_IXGRP ?? 0o010,
        C.S_IROTH ?? 0o004, C.S_IWOTH ?? 0o002, C.S_IXOTH ?? 0o001,
    ]
    let result = ''
    for (let i = 0; i < c.length; i++) {
        result += item.mode & c[i] ? s[i] : e[i]
    }
    return result
}

export type PanelFile = SFTPFile & { owner?: string; group?: string }

// russh's SFTP readdir attrs don't reliably carry owner (uid/gid come back 0, names empty),
// so we get real owner/group from `ls -la` over an exec channel and parse it here.
// Long-format line: <perms> <links> <owner> <group> <size> <mon> <day> <time> <name…>
// Skips the "total" header and any line whose first field isn't a perms string. A trailing
// ACL/xattr marker (+/@/.) on perms is tolerated. Symlink names ("link -> target") are cut at
// " -> ". The name capture (.+) keeps spaces intact. Returns filename → {owner, group}.
const LS_LINE = /^[-dlbcps][-rwxsStT]{9}[.+@]?\s+\d+\s+(\S+)\s+(\S+)\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/
export function parseLsOwners (output: string): Map<string, { owner: string, group: string }> {
    const map = new Map<string, { owner: string, group: string }>()
    for (const line of output.split('\n')) {
        const m = LS_LINE.exec(line.replace(/\r$/, ''))
        if (!m) { continue }
        const name = m[3].split(' -> ')[0]
        if (name === '.' || name === '..') { continue }
        map.set(name, { owner: m[1], group: m[2] })
    }
    return map
}

// The current folder's own mode isn't reliable via russh stat() (returns 000 on some servers),
// but readdir carries it — so we pick the folder's entry out of its PARENT listing. Returns null
// for root (no parent) or when the entry is absent → caller falls back to stat.
export function folderEntryFromParent (dir: string, parentList: SFTPFile[]): SFTPFile | null {
    if (posix.dirname(dir) === dir) { return null }
    return parentList.find(e => e.fullPath === dir) ?? null
}

function compare (a: PanelFile, b: PanelFile, column: SortColumn): number {
    if (column === 'size') { return a.size - b.size }
    if (column === 'modified') { return +new Date(a.modified as any) - +new Date(b.modified as any) }
    if (column === 'owner') { return (a.owner || '').localeCompare(b.owner || '') }
    if (column === 'group') { return (a.group || '').localeCompare(b.group || '') }
    return a.name.localeCompare(b.name)
}

export function sortFiles (list: PanelFile[], column: SortColumn, dir: SortDir): PanelFile[] {
    const dirKey = (x: PanelFile) => x.isDirectory ? 1 : 0
    const sign = dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) =>
        dirKey(b) - dirKey(a) ||           // directories always first
        sign * compare(a, b, column))
}

export function filterFiles (list: PanelFile[], text: string): PanelFile[] {
    const q = text.trim().toLowerCase()
    if (!q) { return list }
    return list.filter(i => i.name.toLowerCase().includes(q))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Compact transfer timestamp: same day as `now` → "HH:mm", else "MMM d, HH:mm".
export function formatTransferTime (date: Date, now: Date): string {
    const p = (n: number): string => String(n).padStart(2, '0')
    const hm = `${p(date.getHours())}:${p(date.getMinutes())}`
    const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate()
    return sameDay ? hm : `${MONTHS[date.getMonth()]} ${date.getDate()}, ${hm}`
}

export function formatSize (bytes: number): string {
    if (!isFinite(bytes) || bytes < 0) { return '' }
    const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']
    let n = bytes, i = 0
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
    return `${i === 0 ? String(n) : n.toFixed(1)} ${units[i]}`
}

export interface Bit3 { r: boolean, w: boolean, x: boolean }
export interface Perms { u: Bit3, g: Bit3, o: Bit3 }

export function octalToPerms (mode: number): Perms {
    const m = mode & 0o777
    const triad = (shift: number): Bit3 => ({
        r: !!(m & (0o4 << shift)),
        w: !!(m & (0o2 << shift)),
        x: !!(m & (0o1 << shift)),
    })
    return { u: triad(6), g: triad(3), o: triad(0) }
}

export function permsToOctal (p: Perms): number {
    const triad = (b: Bit3): number => (b.r ? 4 : 0) | (b.w ? 2 : 0) | (b.x ? 1 : 0)
    return (triad(p.u) << 6) | (triad(p.g) << 3) | triad(p.o)
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
    id: number
    time: Date
    kind: 'transfer' | 'message'
    level: LogLevel
    text: string
    detail?: string
    // Set on a long, cancellable message row (e.g. recursive chmod). Present → the log
    // shows a Stop button; clicking calls it. Cleared when the op finishes so the button hides.
    onCancel?: () => void
    // transfer-only fields (transfer typed `any` so this module stays
    // tabby-import-free and unit-testable):
    transfer?: any
    isUpload?: boolean
    size?: number
    remotePath?: string
}

// Folder-upload dir plan: expand each file's relative dir to ALL its ancestors
// (so intermediate dirs with no direct files get created too), deduped and sorted
// parents-first so sftp.mkdir never hits a missing parent. rels use posix '/'.
export function expandDirs (rels: string[]): string[] {
    const set = new Set<string>()
    for (const rel of rels) {
        let cur = ''
        for (const p of (rel ? rel.split('/') : [])) { cur = cur ? `${cur}/${p}` : p; set.add(cur) }
    }
    return [...set].sort((a, b) => a.split('/').length - b.split('/').length)
}

// russh surfaces SFTP errors as a Rust-debug dump, e.g.
//   Status(Status { id: 379, status_code: Failure, error_message: "No such file", language_tag: "" })
// Pull out status_code + error_message so the log shows a readable reason instead of the
// raw dump. Servers often send a bare "Failure"/"" error_message (no extra info) — don't
// echo that useless duplicate. Anything that isn't a russh Status passes through unchanged.
export function describeSftpError (e: any): string {
    const raw = e?.message ?? String(e)
    const code = /status_code:\s*(\w+)/.exec(raw)?.[1]
    if (!code) { return raw }
    const msg = /error_message:\s*"([^"]*)"/.exec(raw)?.[1]
    return msg && msg !== '' && msg.toLowerCase() !== code.toLowerCase() ? `${code}: ${msg}` : code
}

// Full, untruncated text for an entry — single source of truth for tooltip AND copy.
export function logFullText (e: LogEntry): string {
    // Keep the header (e.g. "chmod failed on 1 item(s)") in front of the detail so a copied
    // line still names the operation — detail alone doesn't say what failed.
    if (e.kind === 'message') { return e.detail ? `${e.text}\n${e.detail}` : e.text }
    const arrow = e.isUpload ? '↑' : '↓'
    const where = e.remotePath ?? e.text
    return e.size != null ? `${arrow} ${where} ${formatSize(e.size)}` : `${arrow} ${where}`
}

// Pure selection reducer for the log rows. `orderedIds` is the rows in display
// order; `index`/`lastIndex` are positions within it. Mirrors the file-list model.
export function computeLogSelection (
    id: number,
    index: number,
    lastIndex: number,
    current: Set<number>,
    mods: { shift: boolean, ctrl: boolean },
    orderedIds: number[],
): Set<number> {
    if (mods.shift && lastIndex >= 0) {
        const [a, b] = index < lastIndex ? [index, lastIndex] : [lastIndex, index]
        return new Set(orderedIds.slice(a, b + 1))
    }
    if (mods.ctrl) {
        const next = new Set(current)
        if (next.has(id)) { next.delete(id) } else { next.add(id) }
        return next
    }
    return new Set([id])
}

// --- start-folder resolution -------------------------------------------------
// russh exposes no realpath over SFTP, so `~` can't be canonicalized there;
// home is resolved separately (a `pwd` exec) and passed in here. These two are
// pure so they're unit-testable.

/** Whether the configured start dir needs the remote home resolved first. */
export function startNeedsHome (s: string): boolean {
    const v = (s || '').trim()
    return v === '' || v === '~' || v.startsWith('~/')
}

/** Resolve a configured start dir to an absolute path. `home` is the resolved
 *  remote home (or null if unavailable). Non-absolute, non-`~` input falls back
 *  to '/'. */
export function resolveStartPath (s: string, home: string | null): string {
    const v = (s || '').trim()
    if (v === '' || v === '~') { return home || '/' }
    if (v.startsWith('~/')) { return home ? home.replace(/\/+$/, '') + '/' + v.slice(2) : '/' }
    if (v.startsWith('/')) { return v }
    return '/'
}

// --- column reorder ----------------------------------------------------------

/** Move `drag` to `drop`'s slot in a column-order array (pure). Removes `drag`,
 *  re-inserts it at the index `drop` currently sits at. No-op if either key is
 *  missing or they're equal. Returns a new array. */
export function moveColumn (order: string[], drag: string, drop: string): string[] {
    if (drag === drop) { return order.slice() }
    const from = order.indexOf(drag)
    const to = order.indexOf(drop)
    if (from < 0 || to < 0) { return order.slice() }
    const next = order.slice()
    next.splice(from, 1)
    next.splice(next.indexOf(drop), 0, drag)   // insert before drop's new position
    return next
}

// True when a file is big enough to warrant a "might be binary" confirmation
// before opening it in a text editor. limitMB <= 0 disables the check.
export function isBigFile (size: number, limitMB: number): boolean {
    return limitMB > 0 && size > limitMB * 1024 * 1024
}

// Extract the editor executable from Windows `ftype` output, e.g.
//   `txtfile="C:\Windows\system32\NOTEPAD.EXE" "%1"` -> `C:\Windows\system32\NOTEPAD.EXE`
//   `txtfile=%SystemRoot%\system32\NOTEPAD.EXE %1`   -> `%SystemRoot%\system32\NOTEPAD.EXE`
// Env vars like %SystemRoot% are left intact (spawned with shell). '' if nothing usable.
export function parseFtypeExe (ftypeOutput: string): string {
    const eq = ftypeOutput.indexOf('=')
    if (eq < 0) { return '' }
    const rhs = ftypeOutput.slice(eq + 1).trim()
    if (rhs.startsWith('"')) {
        const end = rhs.indexOf('"', 1)
        return end > 0 ? rhs.slice(1, end) : ''
    }
    // unquoted: exe is everything up to the first " %<arg>" placeholder
    const cut = rhs.search(/\s+%/)
    return (cut >= 0 ? rhs.slice(0, cut) : rhs).trim()
}

// Parse names (first colon field) from `getent passwd`/`group` or /etc/passwd|group output.
// Skips blanks/comments, dedupes, sorts. Used to populate the chown dropdowns.
export function parseNames (getentOutput: string): string[] {
    const set = new Set<string>()
    for (const line of getentOutput.split('\n')) {
        const name = line.split(':', 1)[0].trim()
        if (name && !name.startsWith('#')) { set.add(name) }
    }
    return [...set].sort((a, b) => a.localeCompare(b))
}

/** POSIX single-quote a string for safe use in a shell command. */
export function shQuote (s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'" }

/** `cp -r` command copying srcs into dest dir; `2>&1` folds stderr into stdout for error reporting. */
export function buildCpCommand (srcs: string[], dest: string): string {
    return 'cp -r -- ' + srcs.map(shQuote).join(' ') + ' ' + shQuote(dest) + ' 2>&1'
}
