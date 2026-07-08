import { Injectable } from '@angular/core'
import { TranslateService, LocaleService } from 'tabby-core'

// Merges our panel's own translations INTO Tabby's live ngx-translate catalog. We only ship
// strings Tabby doesn't already translate — shared labels (Copy, Download, Delete, Cancel,
// Edit locally, Name, Group, Left, Right, Clear, Create directory, File transfers) resolve
// from Tabby's own locale/*.po for free, so our .po deliberately omits them. See locale/*.po.
//
// setTranslation(lang, dict, /*merge*/true) adds our keys without wiping Tabby's. Tabby loads
// each lang's catalog exactly once (guarded), so merging once per lang is safe. localeChanged$
// fires after Tabby has (re)loaded the new lang, so we always merge on top of it.
@Injectable({ providedIn: 'root' })
export class SftpI18nService {
    private loaded = new Set<string>()

    constructor (private translate: TranslateService, locale: LocaleService) {
        this.merge(locale.getLocale())
        locale.localeChanged$.subscribe(lang => this.merge(lang))
    }

    private merge (lang: string): void {
        if (this.loaded.has(lang)) { return }
        let po: any
        // Dynamic require → webpack bundles every locale/*.po as a context; new langs auto-included.
        try { po = require(`../locale/${lang}.po`) } catch { return } // no catalog for this lang
        const src = po.translations['']
        const dict: Record<string, string> = {}
        for (const k of Object.keys(src)) { if (src[k].msgstr[0]) { dict[k] = src[k].msgstr[0] } }
        this.translate.setTranslation(lang, dict, true)
        this.loaded.add(lang)
        // Panels usually mount BEFORE we merge, so their `translate` pipes have already cached the
        // English key. setTranslation only emits onTranslationChange, and ngx-translate's pipe gates
        // that event on `currentLang` — but Tabby only ever sets defaultLang (currentLang stays
        // undefined), so the pipes ignore it and keep showing English until some unrelated change
        // detection re-runs. onDefaultLangChange has no such gate: emitting it makes every live pipe
        // re-evaluate now. Only fire it for the active default lang.
        if (lang === (this.translate as any).defaultLang) {
            this.translate.onDefaultLangChange.emit({ lang, translations: (this.translate as any).translations[lang] })
        }
    }
}
