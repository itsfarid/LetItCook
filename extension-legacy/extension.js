// LetItCook GNOME Shell Extension (GNOME 42-44 Legacy)
const { Clutter, Gio, GLib, GObject, St } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const STATUS = Object.freeze({
    COOKING: 'cooking',
    YOUR_TURN: 'your_turn',
    DONE: 'done',
    BURN: 'burn',
    UNKNOWN: 'unknown',
});

const STATUS_META = Object.freeze({
    [STATUS.COOKING]: { label: 'Cooking', emoji: '🟡', priority: 3 },
    [STATUS.YOUR_TURN]: { label: 'Your Turn', emoji: '🟠', priority: 4 },
    [STATUS.DONE]: { label: 'Done', emoji: '🟢', priority: 2 },
    [STATUS.BURN]: { label: 'Burn', emoji: '🔴', priority: 5 },
    [STATUS.UNKNOWN]: { label: 'Unknown', emoji: '⚪', priority: 1 },
});

const STALE_TIMEOUT_MS = 5 * 60 * 1000;
const DEBOUNCE_DELAY_MS = 150;

function formatElapsed(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
}

function shortCwd(cwd) {
    if (!cwd) return 'global';
    const home = GLib.get_home_dir();
    let p = cwd;
    if (p.startsWith(home)) p = '~' + p.slice(home.length);
    const parts = p.split('/').filter(Boolean);
    if (parts.length <= 2) return p;
    return parts.slice(-2).join('/');
}

const LetItCookButton = GObject.registerClass(
class LetItCookButton extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'LetItCook', false);

        this._stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'letitcook', 'sessions']);
        GLib.mkdir_with_parents(this._stateDir, 0o755);

        this._container = new St.BoxLayout({
            style_class: 'letitcook-panel-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._dot = new St.Widget({
            style_class: 'letitcook-dot letitcook-dot-unknown',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._label = new St.Label({
            text: 'LetItCook',
            style_class: 'letitcook-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._container.add_child(this._dot);
        this._container.add_child(this._label);
        this.add_child(this._container);

        this._currentSessions = [];
        this._currentAggregate = STATUS.UNKNOWN;
        this._debounceTimerId = null;

        // Lazy menu construction: only build actors when menu opens
        this._menuOpenId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                this._rebuildMenu();
            }
        });

        this._watchDir();
        this._startTimer();
        this._update();
    }

    _watchDir() {
        try {
            const dirFile = Gio.File.new_for_path(this._stateDir);
            this._dirMonitor = dirFile.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._dirMonitorId = this._dirMonitor.connect('changed', () => {
                this._scheduleDebouncedUpdate();
            });
        } catch (e) {
            log(`[LetItCook] Failed to monitor directory: ${e}`);
        }
    }

    _scheduleDebouncedUpdate() {
        if (this._debounceTimerId) {
            GLib.Source.remove(this._debounceTimerId);
            this._debounceTimerId = null;
        }
        this._debounceTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_DELAY_MS, () => {
            this._debounceTimerId = null;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _startTimer() {
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _readSessions() {
        const sessions = [];
        const dirFile = Gio.File.new_for_path(this._stateDir);

        try {
            const enumerator = dirFile.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            const now = Date.now();

            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.endsWith('.json') || name.startsWith('.')) continue;

                const filePath = GLib.build_filenamev([this._stateDir, name]);
                const file = Gio.File.new_for_path(filePath);
                try {
                    const [ok, contents] = file.load_contents(null);
                    if (ok) {
                        const raw = JSON.parse(new TextDecoder().decode(contents));
                        const sessionId = String(raw.session_id || raw.sid || name.replace(/\.json$/, ''));
                        const agent = String(raw.agent || 'unknown');
                        const cwd = String(raw.cwd || '');
                        const title = String(raw.title || '');
                        const reason = String(raw.reason || '');
                        const pid = typeof raw.pid === 'number' ? raw.pid : null;
                        const updatedAt = typeof raw.updated_at === 'number' ? raw.updated_at : now;
                        const confidence = String(raw.confidence || 'medium');

                        let status = raw.status;
                        if (!Object.values(STATUS).includes(status)) {
                            status = STATUS.UNKNOWN;
                        }

                        let stale = false;
                        const hasPid = pid !== null;
                        const isPidAlive = hasPid ? GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS) : true;

                        // Lifecycle check: terminated session removal
                        if (hasPid && !isPidAlive) {
                            if (status === STATUS.DONE || status === STATUS.BURN) {
                                // Session completed/ended and process terminated -> remove state file and exclude
                                try {
                                    file.delete(null);
                                } catch (e) {}
                                continue;
                            } else if (status === STATUS.COOKING || status === STATUS.YOUR_TURN) {
                                // Process died unexpectedly -> mark Unknown (crash)
                                stale = true;
                                status = STATUS.UNKNOWN;
                            }
                        }

                        if (status === STATUS.COOKING || status === STATUS.YOUR_TURN) {
                            if (now - updatedAt > STALE_TIMEOUT_MS) {
                                stale = true;
                                status = STATUS.UNKNOWN;
                            }
                        }

                        sessions.push({
                            session_id: sessionId,
                            agent,
                            status,
                            reason,
                            title,
                            cwd,
                            pid,
                            updated_at: updatedAt,
                            stale,
                            filePath,
                        });
                    }
                } catch (e) {
                    sessions.push({
                        session_id: name.replace(/\.json$/, ''),
                        agent: 'unknown',
                        status: STATUS.UNKNOWN,
                        reason: 'unreadable state',
                        title: '',
                        cwd: '',
                        pid: null,
                        updated_at: now,
                        stale: true,
                        confidence: 'low',
                        filePath,
                    });
                }
            }
        } catch (e) {
            log(`[LetItCook] Error reading sessions: ${e}`);
        }

        // ponytail: sort by status priority desc then recency, upgrade when custom sort needed
        sessions.sort((a, b) => {
            const pA = (STATUS_META[a.status] || STATUS_META[STATUS.UNKNOWN]).priority;
            const pB = (STATUS_META[b.status] || STATUS_META[STATUS.UNKNOWN]).priority;
            if (pA !== pB) return pB - pA;
            return b.updated_at - a.updated_at;
        });

        return sessions;
    }

    _update() {
        const sessions = this._readSessions();
        this._currentSessions = sessions;

        let dominant = STATUS.UNKNOWN;
        let maxPriority = 0;

        for (const s of sessions) {
            const meta = STATUS_META[s.status] || STATUS_META[STATUS.UNKNOWN];
            if (meta.priority > maxPriority) {
                maxPriority = meta.priority;
                dominant = s.status;
            }
        }

        this._currentAggregate = dominant;

        // Lightweight indicator update: update dot class and label text only
        for (const st of Object.values(STATUS)) {
            this._dot.remove_style_class_name(`letitcook-dot-${st}`);
        }
        this._dot.add_style_class_name(`letitcook-dot-${dominant}`);

        if (sessions.length === 0) {
            this._label.text = 'LetItCook';
        } else {
            const meta = STATUS_META[dominant] || STATUS_META[STATUS.UNKNOWN];
            this._label.text = `${meta.emoji} ${meta.label}`;
        }

        // Only reconstruct menu items if the popup menu is actively open
        if (this.menu && this.menu.isOpen) {
            this._rebuildMenu();
        }
    }

    _rebuildMenu() {
        this.menu.removeAll();

        const now = Date.now();
        const sessions = this._currentSessions;
        const meta = STATUS_META[this._currentAggregate] || STATUS_META[STATUS.UNKNOWN];

        // Header
        let headerText = 'LetItCook — No active agents';
        if (sessions.length > 0) {
            headerText = `LetItCook — ${meta.emoji} ${meta.label} (${sessions.length} session${sessions.length > 1 ? 's' : ''})`;
        }
        const headerItem = new PopupMenu.PopupMenuItem(headerText, { reactive: false });
        headerItem.add_style_class_name('letitcook-menu-header');
        this.menu.addMenuItem(headerItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (sessions.length === 0) {
            const emptyItem = new PopupMenu.PopupMenuItem('No active agent sessions detected.', { reactive: false });
            emptyItem.add_style_class_name('letitcook-empty-label');
            this.menu.addMenuItem(emptyItem);
            return;
        }

        for (const s of sessions) {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: true });
            item.add_style_class_name('letitcook-session-item');

            const itemBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'letitcook-session-box',
            });

            const sMeta = STATUS_META[s.status] || STATUS_META[STATUS.UNKNOWN];
            const titleText = `${sMeta.emoji} [${s.agent}] ${s.title || shortCwd(s.cwd)}`;
            const titleLabel = new St.Label({
                text: titleText,
                style_class: 'letitcook-session-title',
            });

            const elapsed = formatElapsed(now - s.updated_at);
            const subText = `${sMeta.label}${s.reason ? ': ' + s.reason : ''} • ${elapsed}${s.cwd ? ' • ' + shortCwd(s.cwd) : ''}`;
            const subLabel = new St.Label({
                text: subText,
                style_class: 'letitcook-session-subtitle',
            });

            itemBox.add_child(titleLabel);
            itemBox.add_child(subLabel);
            item.add_child(itemBox);

            if (s.cwd) {
                item.connect('activate', () => {
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, s.cwd);
                    Main.notify('LetItCook', `Copied path to clipboard: ${s.cwd}`);
                });
            }

            this.menu.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const clearItem = new PopupMenu.PopupMenuItem('Clear Inactive Sessions');
        clearItem.connect('activate', () => {
            for (const s of sessions) {
                if (s.status === STATUS.DONE || s.status === STATUS.UNKNOWN || s.stale) {
                    try {
                        const f = Gio.File.new_for_path(s.filePath);
                        f.delete(null);
                    } catch {}
                }
            }
            this._update();
        });
        this.menu.addMenuItem(clearItem);
    }

    destroy() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        if (this._debounceTimerId) {
            GLib.Source.remove(this._debounceTimerId);
            this._debounceTimerId = null;
        }
        if (this._dirMonitor) {
            this._dirMonitor.disconnect(this._dirMonitorId);
            this._dirMonitor = null;
        }
        if (this._menuOpenId && this.menu) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }
        super.destroy();
    }
});

let indicator = null;

function init() {}

function enable() {
    indicator = new LetItCookButton();
    Main.panel.addToStatusArea('letitcook', indicator, 1, 'right');
}

function disable() {
    if (indicator) {
        indicator.destroy();
        indicator = null;
    }
}
