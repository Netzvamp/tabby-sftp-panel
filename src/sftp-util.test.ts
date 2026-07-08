import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getFileType, getIcon, getModeString, sortFiles, filterFiles, formatSize, formatTransferTime, octalToPerms, permsToOctal, parseLsOwners, isBigFile, parseFtypeExe } from './sftp-util'
import { logFullText, computeLogSelection, LogEntry, describeSftpError } from './sftp-util'
import { startNeedsHome, resolveStartPath } from './sftp-util'
import { expandDirs, folderEntryFromParent } from './sftp-util'

const f = (over: any) => ({ name: 'x', isDirectory: false, isSymlink: false, mode: 0, size: 0, modified: new Date(0), fullPath: '/x', ...over } as any)

test('getFileType maps known extensions and unknown', () => {
  assert.equal(getFileType('TS'), 'code')
  assert.equal(getFileType('png'), 'image')
  assert.equal(getFileType('xyz'), 'unknown')
})

test('getIcon: directory, symlink, code file, extensionless', () => {
  assert.equal(getIcon(f({ isDirectory: true })), 'fas fa-folder text-info')
  assert.equal(getIcon(f({ isSymlink: true })), 'fas fa-link text-warning')
  assert.equal(getIcon(f({ name: 'a.js' })), 'fa-solid fa-file-code ')
  assert.equal(getIcon(f({ name: 'README' })), 'fas fa-file')
})

test('getModeString renders rwx for 0o755 file', () => {
  // 0o755 regular file -> "   rwxr-xr-x"
  assert.equal(getModeString(f({ mode: 0o755 })), '   rwxr-xr-x')
})

test('sortFiles groups directories first regardless of dir', () => {
  const list = [f({ name: 'b.txt' }), f({ name: 'adir', isDirectory: true }), f({ name: 'a.txt' })]
  assert.deepEqual(sortFiles(list, 'name', 'asc').map(i => i.name), ['adir', 'a.txt', 'b.txt'])
  assert.deepEqual(sortFiles(list, 'name', 'desc').map(i => i.name), ['adir', 'b.txt', 'a.txt'])
})

test('sortFiles by size and modified (numeric)', () => {
  const list = [f({ name: 'big', size: 100 }), f({ name: 'small', size: 10 })]
  assert.deepEqual(sortFiles(list, 'size', 'asc').map(i => i.name), ['small', 'big'])
  const l2 = [f({ name: 'new', modified: new Date(2000) }), f({ name: 'old', modified: new Date(1000) })]
  assert.deepEqual(sortFiles(l2, 'modified', 'asc').map(i => i.name), ['old', 'new'])
})

test('filterFiles is case-insensitive; empty returns all', () => {
  const list = [f({ name: 'Alpha' }), f({ name: 'beta' })]
  assert.deepEqual(filterFiles(list, 'AL').map(i => i.name), ['Alpha'])
  assert.equal(filterFiles(list, '   ').length, 2)
})

test('formatSize: bytes, kB, MB, and invalid', () => {
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(1023), '1023 B')
  assert.equal(formatSize(1536), '1.5 kB')
  assert.equal(formatSize(1048576), '1.0 MB')
  assert.equal(formatSize(-5), '')
})

test('formatTransferTime: same day → HH:mm', () => {
  const now = new Date(2026, 6, 5, 18, 30)
  assert.equal(formatTransferTime(new Date(2026, 6, 5, 9, 4), now), '09:04')
})

test('formatTransferTime: earlier day → MMM d, HH:mm', () => {
  const now = new Date(2026, 6, 5, 18, 30)
  assert.equal(formatTransferTime(new Date(2026, 6, 3, 14, 7), now), 'Jul 3, 14:07')
})

test('octalToPerms/permsToOctal: round-trips and bit placement', () => {
  // round-trips for representative modes
  for (const o of [0o755, 0o644, 0o600, 0o000, 0o777, 0o750, 0o400]) {
    assert.strictEqual(permsToOctal(octalToPerms(o)), o, `round-trip ${o.toString(8)}`)
  }

  // file-type bits are ignored (0o100755 = regular file, rwxr-xr-x)
  assert.strictEqual(permsToOctal(octalToPerms(0o100755)), 0o755, 'masks type bits')

  // individual bit placement
  const p = octalToPerms(0o640)
  assert.deepStrictEqual(p.u, { r: true, w: true, x: false }, 'owner rw-')
  assert.deepStrictEqual(p.g, { r: true, w: false, x: false }, 'group r--')
  assert.deepStrictEqual(p.o, { r: false, w: false, x: false }, 'other ---')

  console.log('octalToPerms/permsToOctal OK')
})

test('folderEntryFromParent: picks the folder from its parent listing', () => {
  const list = [f({ name: 'sub', fullPath: '/home/user/sub', mode: 0o755, isDirectory: true }),
                f({ name: 'other', fullPath: '/home/user/other', mode: 0o700 })]
  // reliable mode comes from the matching parent entry
  assert.strictEqual(folderEntryFromParent('/home/user/sub', list)?.mode, 0o755, 'matched entry')
  // absent from listing → null (caller falls back to stat)
  assert.strictEqual(folderEntryFromParent('/home/user/missing', list), null, 'not found')
  // root has no parent → null
  assert.strictEqual(folderEntryFromParent('/', list), null, 'root')
  console.log('folderEntryFromParent OK')
})

test('describeSftpError: decodes russh Status, keeps real messages, passes others through', () => {
  // bare "Failure" — no extra info, don't echo the duplicate
  assert.equal(
    describeSftpError({ message: 'Status(Status { id: 379, status_code: Failure, error_message: "Failure", language_tag: "" })' }),
    'Failure')
  // server sent a real reason — surface it cleanly
  assert.equal(
    describeSftpError({ message: 'Status(Status { id: 5, status_code: NoSuchFile, error_message: "No such file", language_tag: "" })' }),
    'NoSuchFile: No such file')
  // empty error_message → code only
  assert.equal(
    describeSftpError({ message: 'Status(Status { id: 1, status_code: PermissionDenied, error_message: "", language_tag: "" })' }),
    'PermissionDenied')
  // non-russh error → untouched
  assert.equal(describeSftpError({ message: 'EXDEV: cross-device link' }), 'EXDEV: cross-device link')
  assert.equal(describeSftpError('plain string'), 'plain string')
})

test('logFullText and computeLogSelection: log helpers', () => {
  // --- logFullText ---
  const msg = (over: Partial<LogEntry>): LogEntry =>
      ({ id: 1, time: new Date(0), kind: 'message', level: 'info', text: 'short', ...over })

  assert.equal(logFullText(msg({ detail: 'the full detail' })), 'short\nthe full detail', 'message → header + detail so the operation stays named')
  assert.equal(logFullText(msg({})), 'short', 'message → text when no detail')

  const tx: LogEntry = { id: 2, time: new Date(0), kind: 'transfer', level: 'info', text: 'f.txt', isUpload: true, size: 1024, remotePath: '/x/y' }
  assert.equal(logFullText(tx), '↑ /x/y ' + formatSize(1024), 'upload transfer full text')
  assert.equal(logFullText({ ...tx, isUpload: false }), '↓ /x/y ' + formatSize(1024), 'download arrow')
  assert.equal(logFullText({ ...tx, remotePath: undefined }), '↑ f.txt ' + formatSize(1024), 'falls back to text when no remotePath')

  // --- computeLogSelection ---
  const ids = [10, 20, 30, 40]           // display order (newest-first is irrelevant; these ARE the order)
  const none = new Set<number>()

  // plain click → only that id
  assert.deepEqual([...computeLogSelection(30, 2, -1, none, { shift: false, ctrl: false }, ids)], [30], 'plain click selects one')

  // ctrl toggles: add
  assert.deepEqual([...computeLogSelection(30, 2, 0, new Set([10]), { shift: false, ctrl: true }, ids)].sort(), [10, 30], 'ctrl adds')
  // ctrl toggles: remove
  assert.deepEqual([...computeLogSelection(10, 0, 0, new Set([10, 30]), { shift: false, ctrl: true }, ids)], [30], 'ctrl removes')

  // shift range ascending (anchor index 1 → click index 3)
  assert.deepEqual([...computeLogSelection(40, 3, 1, none, { shift: true, ctrl: false }, ids)], [20, 30, 40], 'shift range asc')
  // shift range descending (anchor 3 → click 1)
  assert.deepEqual([...computeLogSelection(20, 1, 3, none, { shift: true, ctrl: false }, ids)], [20, 30, 40], 'shift range desc')
  // shift with no prior anchor → single
  assert.deepEqual([...computeLogSelection(30, 2, -1, none, { shift: true, ctrl: false }, ids)], [30], 'shift w/o anchor → single')

  console.log('log helper tests passed')
})

test('parseLsOwners: names, symlink, spaces, numeric ids, skips total/./..', () => {
  const out = [
    'total 20',
    'drwxr-xr-x  5 root  root   4096 Jul  7 10:00 .',
    'drwxr-xr-x 20 root  root   4096 Jul  1 09:00 ..',
    '-rw-r--r--  1 alice users   123 Jul  7 09:59 file.txt',
    'lrwxrwxrwx  1 bob   bob      10 Jul  7 09:00 link -> /tmp/target',
    '-rw-r--r--  1 1001  2002      0 Jul  7 09:00 spaced name.txt',
    'drwxr-xr-x+ 2 carol staff   4096 Jul  7 09:00 acldir',       // ACL '+' suffix on perms
  ].join('\n')
  const m = parseLsOwners(out)
  assert.equal(m.get('file.txt')?.owner, 'alice')
  assert.equal(m.get('file.txt')?.group, 'users')
  assert.equal(m.get('link')?.owner, 'bob')            // symlink target stripped from name
  assert.equal(m.get('spaced name.txt')?.owner, '1001')  // numeric id + spaces in name
  assert.equal(m.get('spaced name.txt')?.group, '2002')
  assert.equal(m.get('acldir')?.owner, 'carol')        // '+' ACL suffix tolerated
  assert.equal(m.has('.'), false)
  assert.equal(m.has('..'), false)
})

test('expandDirs: ancestors, dedup, parents-first, root files', () => {
  // "a/b" and "c" as file dirs → must also create intermediate "a"
  assert.deepEqual(expandDirs(['a/b', 'c']), ['a', 'c', 'a/b'])
  // root-level files (rel '') create nothing
  assert.deepEqual(expandDirs(['', '']), [])
  // dedup + deep nesting sorted shallow→deep
  assert.deepEqual(expandDirs(['a/b/c', 'a/b', 'a']), ['a', 'a/b', 'a/b/c'])
})

test('sortFiles by owner and group', () => {
  const list = [f({ name: 'a', owner: 'zoe', group: 'zulu' }), f({ name: 'b', owner: 'amy', group: 'alpha' })]
  assert.deepEqual(sortFiles(list, 'owner', 'asc').map(i => i.name), ['b', 'a'])
  assert.deepEqual(sortFiles(list, 'owner', 'desc').map(i => i.name), ['a', 'b'])
  assert.deepEqual(sortFiles(list, 'group', 'asc').map(i => i.name), ['b', 'a'])
})

test('startNeedsHome: empty/~ /~sub need home; absolute/relative do not', () => {
  assert.equal(startNeedsHome(''), true)
  assert.equal(startNeedsHome('  '), true)
  assert.equal(startNeedsHome('~'), true)
  assert.equal(startNeedsHome('~/www'), true)
  assert.equal(startNeedsHome('/var/www'), false)
  assert.equal(startNeedsHome('www'), false)
})

test('resolveStartPath: ~, ~/sub, absolute, relative, home null', () => {
  assert.equal(resolveStartPath('~', '/home/rob'), '/home/rob')
  assert.equal(resolveStartPath('', '/home/rob'), '/home/rob')
  assert.equal(resolveStartPath('~/www', '/home/rob'), '/home/rob/www')
  assert.equal(resolveStartPath('~/www', '/home/rob/'), '/home/rob/www')  // trailing slash trimmed
  assert.equal(resolveStartPath('/var/www', '/home/rob'), '/var/www')
  assert.equal(resolveStartPath('relative', '/home/rob'), '/')            // garbage -> safe root
  assert.equal(resolveStartPath('~', null), '/')                         // home unresolved
  assert.equal(resolveStartPath('~/www', null), '/')
})

test('isBigFile: below/at/above limit and disabled', () => {
  assert.equal(isBigFile(500 * 1024, 1), false)        // 500 KB < 1 MB
  assert.equal(isBigFile(1024 * 1024, 1), false)       // exactly 1 MB is not "> limit"
  assert.equal(isBigFile(2 * 1024 * 1024, 1), true)    // 2 MB > 1 MB
  assert.equal(isBigFile(2 * 1024 * 1024, 0), false)   // limit 0 disables the warning
})

test('parseFtypeExe: quoted, unquoted-with-env, spaced path, garbage', () => {
  assert.equal(parseFtypeExe('txtfile="C:\\Windows\\system32\\NOTEPAD.EXE" "%1"'),
    'C:\\Windows\\system32\\NOTEPAD.EXE')
  assert.equal(parseFtypeExe('txtfile=%SystemRoot%\\system32\\NOTEPAD.EXE %1'),
    '%SystemRoot%\\system32\\NOTEPAD.EXE')
  assert.equal(parseFtypeExe('VSCode.txt="C:\\Program Files\\Microsoft VS Code\\Code.exe" "%1"'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe')
  assert.equal(parseFtypeExe('no equals here'), '')
  assert.equal(parseFtypeExe(''), '')
})

import { moveColumn } from './sftp-util'
test('moveColumn: reorder, before/after, no-ops', () => {
  const o = ['name', 'size', 'modified', 'perms']
  assert.deepEqual(moveColumn(o, 'perms', 'name'), ['perms', 'name', 'size', 'modified'])  // to front
  assert.deepEqual(moveColumn(o, 'name', 'perms'), ['size', 'modified', 'name', 'perms'])  // drops before target
  assert.deepEqual(moveColumn(o, 'modified', 'size'), ['name', 'modified', 'size', 'perms'])  // backward, before target
  assert.deepEqual(moveColumn(o, 'size', 'modified'), o)     // already just before target -> unchanged
  assert.deepEqual(moveColumn(o, 'name', 'name'), o)          // same -> copy
  assert.deepEqual(moveColumn(o, 'ghost', 'name'), o)         // missing -> copy
  assert.notEqual(moveColumn(o, 'name', 'name'), o)           // new array, not mutated
})

import { parseNames } from './sftp-util'
test('parseNames: names from getent/passwd, dedupe+sort, skip blanks/comments', () => {
  const out = 'root:x:0:0:root:/root:/bin/bash\nbin:x:1:1::/bin:/usr/sbin/nologin\n# comment\n\nalice:x:1000:1000::/home/alice:/bin/bash\n'
  assert.deepEqual(parseNames(out), ['alice', 'bin', 'root'])
  assert.deepEqual(parseNames(''), [])
  assert.deepEqual(parseNames('root:x:0\nroot:x:0'), ['root'])   // dedupe
})

import { shQuote, buildCpCommand } from './sftp-util'
test('shQuote: plain, spaces, embedded single quote', () => {
  assert.equal(shQuote('/a/b'), "'/a/b'")
  assert.equal(shQuote('with space'), "'with space'")
  assert.equal(shQuote("a'b"), "'a'\\''b'")
})
test('buildCpCommand: quotes each src + dest, appends 2>&1', () => {
  assert.equal(buildCpCommand(['/a', '/b'], '/dest'), "cp -r -- '/a' '/b' '/dest' 2>&1")
  assert.equal(buildCpCommand(["/x'y"], '/d'), "cp -r -- '/x'\\''y' '/d' 2>&1")
})
