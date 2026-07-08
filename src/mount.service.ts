import { Injectable, EnvironmentInjector, ApplicationRef, createComponent, ComponentRef } from '@angular/core'
import { AppService, ConfigService, PlatformService } from 'tabby-core'
import { SftpPanelComponent } from './panel.component'
import { LogService } from './log.service'
import { dockSize } from './logic'

const STRIP = 24  // collapsed strip width (px) with the vertical label
const STRIP_SLIM = 8  // collapsed strip width (px) when the label is hidden

interface Mounted {
    ref: ComponentRef<SftpPanelComponent>
    host: HTMLElement
    spacer: HTMLElement      // unpinned: a flex sibling reserving the strip's width so the
                             // collapsed strip doesn't overlay the terminal; the host floats over it
    tabEl: HTMLElement       // the <split-tab> element (the top-level tab)
    container: HTMLElement   // tab-body (a flex row) — our host is its flex child
    tab: any
    expanded: boolean        // unpinned only: strip (false) vs. hovered-open (true)
    hovering: boolean
    dismissed?: boolean      // Esc collapsed it while hovered — suppress hover-expand until
                             // the pointer actually leaves and re-enters

    pinnedState?: boolean    // last-applied pinned value, to detect pin→unpin transitions
    collapseTimer?: any
    resizing?: boolean       // width-drag in progress — hold open (mouseleave fires mid-drag)
}

@Injectable({ providedIn: 'root' })
export class PanelMountService {
    // Keyed by the TOP-LEVEL tab (SplitTabComponent), not per SSH pane — one panel per
    // tab, spanning full height beside the whole split, not a small one inside each pane.
    private mounts = new WeakMap<object, Mounted>()
    private watched = new WeakSet<object>()

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        private log: LogService,
        private injector: EnvironmentInjector,
        private appRef: ApplicationRef,
    ) {
        this.sweepTabs()
        this.app.tabOpened$.subscribe(() => this.sweepTabs())
        this.app.tabsChanged$.subscribe(() => this.sweepTabs())
        // Esc collapses a hover-opened panel too (focus is still in the terminal then, so the
        // panel's own handler never sees the key). Don't consume the event — the terminal
        // still gets Esc. Skip when focus is inside the panel (its component handles that).
        // Capture phase: xterm consumes keydown before it bubbles to document, so a bubble
        // listener would never see Esc while the terminal is focused. Capture runs first.
        document.addEventListener('keydown', e => this.onGlobalEscape(e), true)
    }

    private onGlobalEscape (e: KeyboardEvent): void {
        if (e.key !== 'Escape') { return }
        if (this.config.store?.sftpPanel?.pinned) { return }
        const m = this.mounts.get(this.app.activeTab)
        if (!m || !m.expanded || m.host.contains(document.activeElement)) { return }
        m.dismissed = true
        this.setExpanded(m, false)
    }

    private isSSHTab (tab: any): boolean {
        return !!tab && typeof tab.openSFTP === 'function' && 'sshSession' in tab
    }

    private allTabs (topTab: any): any[] {
        return typeof topTab.getAllTabs === 'function' ? topTab.getAllTabs() : [topTab]
    }

    private sshPanes (topTab: any): any[] {
        return this.allTabs(topTab).filter(t => this.isSSHTab(t))
    }

    // The SSH pane whose SFTP the panel should show: the focused one, else the first.
    private focusedSSHPane (topTab: any): any | null {
        const f = typeof topTab.getFocusedTab === 'function' ? topTab.getFocusedTab() : topTab
        if (this.isSSHTab(f)) { return f }
        return this.sshPanes(topTab)[0] ?? null
    }

    // The <split-tab> DOM element for a top-level tab. BaseTabComponent has NO `.element`
    // (only terminal tabs inject ElementRef) — a SplitTabComponent doesn't — so read the
    // host node off its ViewRef. Fallback: a pane's element, whose parent is the split-tab.
    private splitTabEl (topTab: any): HTMLElement | null {
        const rn = (topTab.hostView as any)?.rootNodes
        if (rn && rn[0] instanceof HTMLElement) { return rn[0] }
        const paneEl = this.focusedSSHPane(topTab)?.element?.nativeElement as HTMLElement | undefined
        return paneEl?.parentElement ?? null
    }

    private sweepTabs (): void {
        for (const top of this.app.tabs) { this.watchTopTab(top) }
    }

    // Watch a top-level tab: mount the panel once it holds an SSH pane (always — the panel
    // is a permanent edge strip, no button/opt-in). Panes may appear asynchronously
    // (startup-restored splits populate in ngAfterViewInit → initialized$; later splits →
    // tabAdded$; drag-in → tabAdopted$).
    private watchTopTab (topTab: any): void {
        this.ensureMounted(topTab)
        if (this.watched.has(topTab)) { return }
        this.watched.add(topTab)
        const rescan = () => this.ensureMounted(topTab)
        topTab.initialized$?.subscribe?.(rescan)
        topTab.tabAdded$?.subscribe?.(rescan)
        topTab.tabAdopted$?.subscribe?.(rescan)
    }

    private ensureMounted (topTab: any): void {
        if (this.mounts.get(topTab)) { return }
        if (!this.sshPanes(topTab).length) { return }
        this.mount(topTab)
    }

    // Hotkey action: reveal the active tab's panel (expand it if it's a collapsed strip) and
    // focus its file list, so navigation starts immediately from the keyboard.
    focusPanel (): void {
        const top = this.app.activeTab
        const m = top && this.mounts.get(top)
        if (!m) { return }
        this.cancelCollapse(m)
        if (!this.config.store.sftpPanel.pinned) { this.setExpanded(m, true) }  // renders sp-body + CD
        ;(m.host.querySelector('.sp-body') as HTMLElement | null)?.focus({ preventScroll: true })
    }

    private ensureStyle (): void {
        if (document.getElementById('sftp-panel-style')) { return }
        const el = document.createElement('style')
        el.id = 'sftp-panel-style'
        el.textContent = `
          .sftp-panel-host:not(.pinned) { box-shadow: 0 0 12px rgba(0,0,0,.4); }
          .sftp-panel-host.collapsed > .sftp-panel-drag { display: none; }
          .sftp-panel-host > .sftp-panel-drag { position: absolute; top: 0; height: 100%; width: 5px; cursor: col-resize; z-index: 11; }
          .sftp-panel-host > .sftp-panel-drag:hover { background: rgba(255,255,255,.15); }
          .sftp-panel-host.side-left > .sftp-panel-drag { right: 0; }
          .sftp-panel-host.side-right > .sftp-panel-drag { left: 0; }
          /* Reserve the drag handle's 5px as a gutter so content scrollbars sit inboard of
             it, not under it (border-box keeps the padding inside the set width). */
          .sftp-panel-host { box-sizing: border-box; }
          .sftp-panel-host.side-left:not(.collapsed) { padding-right: 5px; }
          .sftp-panel-host.side-right:not(.collapsed) { padding-left: 5px; }
        `
        document.head.appendChild(el)
    }

    private mount (topTab: any): void {
        if (!this.config.store?.sftpPanel) { return }  // config not ready yet (boot); retried on tabsChanged$
        this.ensureStyle()
        const tabEl = this.splitTabEl(topTab)
        if (!tabEl) { return }  // tab not rendered yet
        const container = tabEl.parentElement as HTMLElement | null
        if (!container) { return }

        const host = document.createElement('div')
        host.className = 'sftp-panel-host'
        // Panel clicks must not reach the terminal (which would refocus/steal input).
        host.addEventListener('mousedown', e => e.stopPropagation())
        host.addEventListener('click', e => e.stopPropagation())
        // Spacer: a flex sibling that reserves the collapsed strip's width so the terminal
        // shrinks by it (not overlaid). The host floats above the spacer / terminal.
        const spacer = document.createElement('div')
        spacer.className = 'sftp-panel-spacer'
        container.appendChild(spacer)
        container.appendChild(host)

        const ref = createComponent(SftpPanelComponent, { environmentInjector: this.injector, hostElement: host })
        const pane0 = this.focusedSSHPane(topTab)
        ref.instance.session = pane0?.sshSession ?? null
        ref.instance.shellSession = pane0?.session ?? null
        this.appRef.attachView(ref.hostView)

        const mounted: Mounted = { ref, host, spacer, tabEl, container, tab: topTab, expanded: false, hovering: false }
        this.mounts.set(topTab, mounted)
        // Esc: collapse (no-op when pinned). Mark dismissed so the still-hovering pointer
        // doesn't immediately re-expand it — cleared once the pointer leaves (mouseleave).
        ref.instance.escaped.subscribe(() => { mounted.dismissed = true; this.setExpanded(mounted, false) })

        // Hover: expand the strip; leaving schedules a collapse (guarded by pin-lock).
        host.addEventListener('mouseenter', () => {
            mounted.hovering = true
            if (this.config.store.sftpPanel.pinned) { return }
            if (mounted.dismissed) { return }  // Esc-collapsed while hovered: wait for a real leave/enter
            this.cancelCollapse(mounted)
            this.setExpanded(mounted, true)
        })
        host.addEventListener('mouseleave', () => {
            mounted.hovering = false; mounted.dismissed = false
            if (this.config.store.sftpPanel.pinned) { return }
            this.scheduleCollapse(mounted)
        })

        const subs: any[] = []
        subs.push(topTab.destroyed$?.subscribe?.(() => this.unmount(topTab)))
        const updateSession = () => {
            const pane = this.focusedSSHPane(topTab)
            const s = pane?.sshSession
            if (s) { ref.instance.shellSession = pane?.session ?? null; ref.instance.setSession(s) }
        }
        subs.push(topTab.focusChanged$?.subscribe?.(updateSession))
        subs.push(topTab.tabAdded$?.subscribe?.(updateSession))
        for (const p of this.sshPanes(topTab)) { subs.push(p.sessionChanged$?.subscribe?.(updateSession)) }
        subs.push(this.config.changed$.subscribe(() => this.applyLayout(mounted)))
        ;(mounted as any).subs = subs

        this.applyLayout(mounted)
        this.attachDrag(mounted)
        ref.changeDetectorRef.detectChanges()
    }

    private unmount (topTab: any): void {
        const m = this.mounts.get(topTab)
        if (!m) { return }
        this.cancelCollapse(m)
        for (const s of (m as any).subs ?? []) { s?.unsubscribe?.() }
        m.tabEl.style.minWidth = ''  // restore the split-tab's full width
        this.appRef.detachView(m.ref.hostView)
        m.ref.destroy()
        m.host.remove()
        m.spacer.remove()
        this.mounts.delete(topTab)
    }

    private applyLayout (m: Mounted): void {
        const s = this.config.store.sftpPanel
        const w = Math.max(200, s.width || 420)
        const host = m.host
        // Detect a pin→unpin transition so the panel opens once, then collapses on mouse-out
        // (instead of snapping straight to a strip under the user's cursor).
        if (m.pinnedState === true && !s.pinned) {
            m.expanded = true
            this.scheduleCollapse(m)
        }
        m.pinnedState = !!s.pinned

        host.style.height = ''
        host.style.zIndex = '10'
        host.style.marginLeft = host.style.marginRight = ''
        host.style.left = host.style.right = ''
        host.classList.toggle('side-left', s.side === 'left')
        host.classList.toggle('side-right', s.side !== 'left')
        host.classList.toggle('pinned', !!s.pinned)
        m.tabEl.style.minWidth = '0'  // let the split-tab shrink for the panel/spacer
        if (s.pinned) {
            // Dock: flex sibling of the split-tab → split-tab shrinks, its panes reflow.
            m.spacer.style.display = 'none'
            host.style.transition = ''
            host.style.position = 'relative'
            host.style.top = host.style.bottom = ''
            host.style.width = `${w}px`
            host.style.flex = `0 0 ${w}px`
            host.style.order = s.side === 'left' ? '-1' : '1'
            host.style[s.side === 'left' ? 'marginRight' : 'marginLeft'] = '8px'  // gap
            this.setCollapsed(m, false)
        } else {
            // Strip: the spacer (flex 0 0 STRIP) reserves the strip's width so the terminal
            // shrinks by it — the collapsed strip doesn't overlay the terminal. The host is
            // an absolute overlay that expands over the terminal on hover (no reflow: the
            // spacer stays constant while the host width animates).
            m.spacer.style.display = ''
            m.spacer.style.flex = `0 0 ${this.strip()}px`
            m.spacer.style.order = s.side === 'left' ? '-1' : '1'
            host.style.position = 'absolute'
            host.style.flex = ''
            host.style.order = ''
            host.style.top = '0'
            host.style.bottom = '0'
            host.style[s.side === 'left' ? 'left' : 'right'] = '0'
            host.style.transition = 'width .15s ease'
            host.style.width = `${m.expanded ? w : this.strip()}px`
            this.setCollapsed(m, !m.expanded)
        }
    }

    private setCollapsed (m: Mounted, val: boolean): void {
        m.host.classList.toggle('collapsed', val)
        if (m.ref.instance.collapsed === val) { return }
        m.ref.instance.collapsed = val
        m.ref.changeDetectorRef.detectChanges()
    }

    private setExpanded (m: Mounted, val: boolean): void {
        if (this.config.store.sftpPanel.pinned) { return }
        m.expanded = val
        const w = Math.max(200, this.config.store.sftpPanel.width || 420)
        m.host.style.width = `${val ? w : this.strip()}px`
        this.setCollapsed(m, !val)
    }

    // Collapsed strip width: thinner when the vertical "SFTP Panel" label is hidden.
    private strip (): number {
        return this.config.store.sftpPanel.spineLabel === false ? STRIP_SLIM : STRIP
    }

    private scheduleCollapse (m: Mounted): void {
        this.cancelCollapse(m)
        m.collapseTimer = setTimeout(() => this.tryCollapse(m), 300)
    }

    private cancelCollapse (m: Mounted): void {
        if (m.collapseTimer) { clearTimeout(m.collapseTimer); m.collapseTimer = undefined }
    }

    // Collapse the expanded strip — but not while the mouse is over it, and not while a
    // pin-lock holds it open (native context menu / modal, an input being typed in, or a
    // running transfer). While locked, re-arm and re-check.
    private tryCollapse (m: Mounted): void {
        m.collapseTimer = undefined
        if (this.config.store.sftpPanel.pinned || m.hovering) { return }
        if (m.resizing || this.isLocked(m)) { this.scheduleCollapse(m); return }
        this.setExpanded(m, false)
    }

    private isLocked (m: Mounted): boolean {
        // Native context menu (Electron) or a modal blurs the window; also don't collapse
        // behind the user's back when the window isn't focused.
        if (!document.hasFocus()) { return true }
        if (document.querySelector('ngb-modal-window')) { return true }
        const ae = document.activeElement
        if (ae && m.host.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { return true }
        if (this.log.hasActive()) { return true }
        return false
    }

    private attachDrag (m: Mounted): void {
        const handle = document.createElement('div')
        handle.className = 'sftp-panel-drag'
        m.host.appendChild(handle)
        handle.addEventListener('mousedown', ev => {
            ev.preventDefault()
            m.resizing = true
            this.cancelCollapse(m)
            const side = this.config.store.sftpPanel.side
            const move = (mm: MouseEvent) => {
                // container (tab-body) rect is stable while the split-tab shrinks.
                const rect = m.container.getBoundingClientRect()
                const w = dockSize(side, rect, mm.clientX)
                m.host.style.width = `${w}px`
                if (this.config.store.sftpPanel.pinned) { m.host.style.flex = `0 0 ${w}px` }
            }
            const up = (mm: MouseEvent) => {
                const rect = m.container.getBoundingClientRect()
                this.config.store.sftpPanel.width = dockSize(side, rect, mm.clientX)
                this.config.save()
                m.resizing = false
                if (!m.hovering) { this.scheduleCollapse(m) }  // released off the panel → collapse
                window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
            }
            window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
        })
    }
}
