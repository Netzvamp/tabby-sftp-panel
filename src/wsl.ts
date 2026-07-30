// A WSL tab in Tabby is an ordinary LOCAL tab (profile.type === 'local') that happens to run
// wsl.exe, so the panel already mounts on it — and, before this module existed, showed the
// Windows filesystem while the shell beside it sat in /home. Here we work out which
// distribution a tab is running and where its filesystem is reachable from Windows.
//
// Why not tabby-local's own Shell.fsBase: it exists (_tabby-ref/tabby-local/src/api.ts:16) but
// optionsFromShell (_tabby-ref/tabby-local/src/profiles.ts:79) never copies it into the
// profile, and the default-distro shell does not set it at all
// (_tabby-ref/tabby-electron/src/shells/wsl.ts:62). Nothing reaches us through the profile.

const req = (window as any).require

const WSL_EXES = ['wsl.exe', 'bash.exe']

/** Which distribution a local profile browses:
 *   - `null` — not a WSL profile at all
 *   - `''`   — WSL, but the DEFAULT distro, whose name only the registry knows
 *   - a name — taken from `-d` / `--distribution`
 *  Pure: the caller supplies `profile.options.command` and `.args`. */
export function wslDistroOf (command: string, args: string[]): string | null {
    const exe = (command || '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
    if (!WSL_EXES.includes(exe)) { return null }
    // `length - 1`: a trailing '-d' with no value must not read undefined off the end and
    // build a base of '\\wsl$\undefined'.
    for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '-d' || args[i] === '--distribution') { return args[i + 1] }
    }
    return ''
}

export interface LxssInfo {
    defaultDistro: string | null
    uids: Record<string, number>
}

/** Parse `reg.exe query <Lxss key> /s` output. Structure only, never English words:
 *  reg.exe localizes its MESSAGES (a missing key prints "FEHLER:" on a German Windows) but
 *  not its data lines. Value lines are `<4 spaces><name><4 spaces><type><4 spaces><value>`,
 *  and the value may be empty or contain spaces and backslashes. */
export function parseLxss (out: string): LxssInfo {
    const blocks: Record<string, Record<string, string>> = {}
    let current: Record<string, string> | null = null
    for (const raw of out.split(/\r?\n/)) {
        const key = /^HKEY_[^\s]*\\Lxss(\\.*)?$/.exec(raw.trim())
        if (key) {
            current = blocks[raw.trim()] = {}
            continue
        }
        const value = /^\s{4}(\S+)\s{4}(REG_\w+)(?:\s{4}(.*))?$/.exec(raw)
        if (value && current) { current[value[1]] = (value[3] ?? '').trim() }
    }
    const entries = Object.entries(blocks)
    const root = entries.find(([k]) => k.endsWith('\\Lxss'))
    const defaultGuid = root?.[1].DefaultDistribution ?? null
    const uids: Record<string, number> = {}
    let defaultDistro: string | null = null
    for (const [k, v] of entries) {
        const name = v.DistributionName
        if (!name) { continue }
        // REG_DWORD prints as hex ('0x3e8'). parseInt handles the 0x prefix at radix 16.
        // Missing DefaultUid means the distro was never configured — 1000 is the WSL default.
        uids[name] = v.DefaultUid === undefined ? 1000 : parseInt(v.DefaultUid, 16)
        if (defaultGuid && k.endsWith('\\' + defaultGuid)) { defaultDistro = name }
    }
    return { defaultDistro, uids }
}

/** The home directory of `uid` from an /etc/passwd body, or null.
 *  Fields: name:passwd:uid:gid:gecos:home:shell — the uid is field 3, the home field 6. */
export function homeFromPasswd (passwd: string, uid: number): string | null {
    for (const line of passwd.split(/\r?\n/)) {
        const f = line.split(':')
        if (f.length >= 6 && f[2] === String(uid) && f[5]) { return f[5] }
    }
    return null
}

/** Every distro, WSL1 included, is reachable at this share. Tabby's own shell provider uses
 *  the WSL1 `BasePath\rootfs` form instead, but `\\wsl$` has served WSL1 since Windows 10
 *  1903, so one form covers both and we never touch BasePath. */
export function wslBase (distro: string): string {
    return `\\\\wsl$\\${distro}`
}

// The registry is read at most once per Tabby session: distros are installed and removed far
// less often than tabs are opened, and a failed read must not be retried on every tab.
let lxssCache: Promise<LxssInfo> | null = null

function readLxss (): Promise<LxssInfo> {
    lxssCache ??= new Promise<LxssInfo>(resolve => {
        try {
            const exe = `${process.env.windir ?? 'C:\\Windows'}\\System32\\reg.exe`
            req('child_process').execFile(
                exe,
                ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'],
                { windowsHide: true, timeout: 5000 },
                // reg.exe exits non-zero when the key is missing (no WSL installed). That is
                // not an error worth surfacing — parseLxss returns an empty map either way.
                (_err: any, stdout: string) => resolve(parseLxss(stdout ?? '')),
            )
        } catch {
            resolve({ defaultDistro: null, uids: {} })
        }
    })
    return lxssCache
}

/** The share and default uid for a local profile, or null when it is not a WSL profile — or
 *  is one whose distro cannot be named (no `-d` and no readable registry), in which case the
 *  tab keeps browsing the Windows filesystem exactly as it did before. */
export async function wslBaseFor (profile: any): Promise<{ base: string, uid: number } | null> {
    const named = wslDistroOf(profile?.options?.command ?? '', profile?.options?.args ?? [])
    if (named === null) { return null }
    const info = await readLxss()
    const distro = named || info.defaultDistro
    if (!distro) { return null }
    return { base: wslBase(distro), uid: info.uids[distro] ?? 1000 }
}

/** The distribution home for `uid`, as a posix path inside the distro. Falls back to root's
 *  home and finally to '/', so the panel always has somewhere to open. */
export async function wslHome (base: string, uid: number): Promise<string> {
    try {
        const sep = base.includes('\\') ? '\\' : '/'
        const txt: string = await req('fs').promises.readFile(base + sep + 'etc' + sep + 'passwd', 'utf8')
        return homeFromPasswd(txt, uid) ?? homeFromPasswd(txt, 0) ?? '/'
    } catch {
        return '/'
    }
}
