import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

// The catalogs live at the repo root, not next to the sources.
const localeDir = new URL('../locale/', import.meta.url)

const REFERENCE = 'de-DE.po'

/** msgids of one catalog, minus the `msgid ""` header entry. */
function msgids (file: string): Set<string> {
    const body = readFileSync(new URL(file, localeDir), 'utf8')
    const ids = [...body.matchAll(/^msgid "(.*)"$/gm)].map(m => m[1])
    return new Set(ids.filter(id => id !== ''))
}

const catalogs = readdirSync(localeDir).filter(f => f.endsWith('.po'))
const reference = msgids(REFERENCE)

test('every catalog carries the same msgid set as ' + REFERENCE, () => {
    assert.ok(reference.size > 0, 'reference catalog is empty')
    for (const file of catalogs) {
        if (file === REFERENCE) {
            continue
        }
        const ids = msgids(file)
        const missing = [...reference].filter(id => !ids.has(id))
        const extra = [...ids].filter(id => !reference.has(id))
        assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${file} drifted from ${REFERENCE}`)
    }
})

test('no catalog has an untranslated msgstr', () => {
    for (const file of catalogs) {
        const body = readFileSync(new URL(file, localeDir), 'utf8')
        // Pair each msgid with the msgstr that follows it; the header pair has an empty msgid.
        const pairs = [...body.matchAll(/^msgid "(.*)"\nmsgstr "(.*)"$/gm)]
        const empty = pairs.filter(([, id, str]) => id !== '' && str === '').map(([, id]) => id)
        assert.deepEqual(empty, [], `${file} has empty translations`)
    }
})
