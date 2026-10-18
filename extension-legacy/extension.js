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
// A session whose process is gone stays visible as Unknown for this long, then is
// removed so dead sessions do not pin the panel at Unknown forever.
const DEAD_SESSION_RETENTION_MS = 60 * 60 * 1000;
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

// Restrict a LetItCook-owned directory to owner-only (0700), querying and
// setting attributes with NOFOLLOW_SYMLINKS so a link is never chmod-ed by path.
function ensurePrivateDir(path) {
    try {
        const dirFile = Gio.File.new_for_path(path);
        const flags = Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS;
        const attrs = 'standard::type,unix::mode,owner::user';
        const info = dirFile.query_info(attrs, flags, null);
        if (info.get_file_type() !== Gio.FileType.DIRECTORY ||
            !info.has_attribute('unix::mode') ||
            !info.has_attribute('owner::user') ||
            info.get_attribute_string('owner::user') !== GLib.get_user_name())
            return;
        if ((info.get_attribute_uint32('unix::mode') & 0o777) === 0o700)
            return;
        if (!dirFile.set_attribute_uint32('unix::mode', 0o700, flags, null)) {
            log(`[LetItCook] Could not restrict permissions on ${path}`);
            return;
        }
        const secured = dirFile.query_info(attrs, flags, null);
        if (secured.get_file_type() !== Gio.FileType.DIRECTORY ||
            secured.get_attribute_string('owner::user') !== GLib.get_user_name() ||
            (secured.get_attribute_uint32('unix::mode') & 0o777) !== 0o700)
            log(`[LetItCook] Could not verify private permissions on ${path}`);
    } catch (e) {
        log(`[LetItCook] Could not restrict permissions on ${path}: ${e}`);
    }
}

function ensurePrivateNotifyCacheFile(path) {
    try {
        if (GLib.file_test(path, GLib.FileTest.IS_SYMLINK))
            return false;
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return true;

        const file = Gio.File.new_for_path(path);
        const attributes = 'standard::type,unix::mode,unix::nlink,owner::user';
        const info = file.query_info(attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_file_type() !== Gio.FileType.REGULAR ||
            !info.has_attribute('unix::mode') ||
            !info.has_attribute('unix::nlink') ||
            !info.has_attribute('owner::user') ||
            info.get_attribute_uint32('unix::nlink') !== 1 ||
            info.get_attribute_string('owner::user') !== GLib.get_user_name())
            return false;

        if ((info.get_attribute_uint32('unix::mode') & 0o777) === 0o600)
            return true;

        // Replacement is atomic and does not follow a symlink at the target path.
        const [ok, contents] = file.load_contents(null);
        if (!ok) return false;
        file.replace_contents(contents, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);

        const secured = file.query_info(attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        return secured.get_file_type() === Gio.FileType.REGULAR &&
            secured.has_attribute('unix::mode') &&
            secured.has_attribute('unix::nlink') &&
            secured.has_attribute('owner::user') &&
            secured.get_attribute_uint32('unix::nlink') === 1 &&
            secured.get_attribute_string('owner::user') === GLib.get_user_name() &&
            (secured.get_attribute_uint32('unix::mode') & 0o777) === 0o600;
    } catch (e) {
        log(`[LetItCook] Could not secure notification cache ${path}: ${e}`);
        return false;
    }
}

const LetItCookButton = GObject.registerClass(
class LetItCookButton extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'LetItCook', false);

        this._stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'letitcook', 'sessions']);
        GLib.mkdir_with_parents(this._stateDir, 0o700);
        // Correct pre-existing directories created with broader permissions.
        // Only LetItCook's own two directories are touched, never their parents.
        ensurePrivateDir(GLib.path_get_dirname(this._stateDir));
        ensurePrivateDir(this._stateDir);

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

        this._notifyCacheFile = GLib.build_filenamev([GLib.get_user_state_dir(), 'letitcook', 'notify_cache.json']);
        this._lastSavedCacheJson = null;
        this._notifyCache = this._loadNotifyCache();
        this._notifyDone = this._notifyCache._config && this._notifyCache._config.notifyDone === true;
        this._isFirstScan = true;

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

        let enumerator = null;
        try {
            enumerator = dirFile.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
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
                        let terminated = false;
                        const hasPid = pid !== null;
                        const isPidAlive = hasPid ? GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS) : true;

                        // Lifecycle check: terminated session removal
                        if (hasPid && !isPidAlive) {
                            if (status === STATUS.DONE || status === STATUS.BURN) {
                                // Process terminated after reaching terminal state
                                terminated = true;
                            } else if (status === STATUS.COOKING || status === STATUS.YOUR_TURN) {
                                // Process died unexpectedly -> mark Unknown (crash)
                                stale = true;
                                status = STATUS.UNKNOWN;
                            }
                            // Process gone and no update for the retention window -> remove (never Done)
                            if (status === STATUS.UNKNOWN && now - updatedAt > DEAD_SESSION_RETENTION_MS) {
                                terminated = true;
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
                            confidence,
                            filePath,
                            terminated,
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
                        terminated: false,
                    });
                }
            }
        } catch (e) {
            log(`[LetItCook] Error reading sessions: ${e}`);
        } finally {
            if (enumerator) {
                try {
                    enumerator.close(null);
                } catch (e) {
                    log(`[LetItCook] Error closing enumerator: ${e}`);
                }
            }
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
        // Keep a just-terminated Done/Burn state visible through this update; the file is
        // cleaned below, and the next scan naturally returns to Unknown.
        this._currentSessions = sessions;
        this._checkNotifications(sessions);

        // Clean up terminated session files after notification evaluation
        for (const s of sessions) {
            if (s.terminated && s.filePath) {
                try {
                    const file = Gio.File.new_for_path(s.filePath);
                    file.delete(null);
                } catch (e) {}
            }
        }

        let dominant = STATUS.UNKNOWN;
        let maxPriority = 0;

        for (const s of this._currentSessions) {
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

        if (this._currentSessions.length === 0) {
            this._label.text = 'LetItCook';
        } else {
            const meta = STATUS_META[dominant] || STATUS_META[STATUS.UNKNOWN];
            this._label.text = meta.label;
        }

        // Only reconstruct menu items if the popup menu is actively open
        if (this.menu && this.menu.isOpen) {
            this._rebuildMenu();
        }
    }

    _loadNotifyCache() {
        try {
            if (!ensurePrivateNotifyCacheFile(this._notifyCacheFile)) {
                return { _config: { notifyDone: false }, sessions: {} };
            }
            const file = Gio.File.new_for_path(this._notifyCacheFile);
            if (file.query_exists(null)) {
                const [ok, contents] = file.load_contents(null);
                if (ok) {
                    const parsed = JSON.parse(new TextDecoder().decode(contents));
                    if (parsed && typeof parsed === 'object') {
                        if (!parsed.sessions || typeof parsed.sessions !== 'object') {
                            parsed.sessions = {};
                        }
                        this._lastSavedCacheJson = JSON.stringify(parsed);
                        return parsed;
                    }
                }
            }
        } catch (e) {}
        const fallback = { _config: { notifyDone: false }, sessions: {} };
        this._lastSavedCacheJson = JSON.stringify(fallback);
        return fallback;
    }

    _saveNotifyCache(force = false) {
        try {
            if (!ensurePrivateNotifyCacheFile(this._notifyCacheFile)) return;
            if (!this._notifyCache._config) this._notifyCache._config = {};
            this._notifyCache._config.notifyDone = this._notifyDone;
            const serialized = JSON.stringify(this._notifyCache);
            if (!force && serialized === this._lastSavedCacheJson) {
                return;
            }
            const file = Gio.File.new_for_path(this._notifyCacheFile);
            const bytes = new TextEncoder().encode(serialized);
            file.replace_contents(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
            this._lastSavedCacheJson = serialized;
            ensurePrivateNotifyCacheFile(this._notifyCacheFile);
        } catch (e) {
            log(`[LetItCook] Could not save notification cache: ${e}`);
        }
    }

    _checkNotifications(sessions) {
        if (!this._notifyCache.sessions) {
            this._notifyCache.sessions = {};
        }

        const activeIds = new Set();

        for (const s of sessions) {
            if (!s || !s.session_id) continue;
            const sid = s.session_id;
            activeIds.add(sid);

            const cached = this._notifyCache.sessions[sid];

            if (this._isFirstScan) {
                if (!cached) {
                    this._notifyCache.sessions[sid] = {
                        lastStatus: s.status,
                        notifiedStatus: null,
                    };
                }
                continue;
            }

            const prevStatus = cached ? cached.lastStatus : null;

            let shouldAlert = false;
            if (s.status !== prevStatus && !s.stale && s.confidence !== 'low') {
                if (s.status === STATUS.YOUR_TURN) {
                    shouldAlert = true;
                } else if (s.status === STATUS.BURN) {
                    shouldAlert = true;
                } else if (s.status === STATUS.DONE && this._notifyDone && prevStatus === STATUS.COOKING) {
                    shouldAlert = true;
                }
            }

            if (shouldAlert) {
                if (!cached || cached.notifiedStatus !== s.status) {
                    const title = `LetItCook: ${s.agent || 'Agent'}`;
                    const subject = s.title || shortCwd(s.cwd);
                    let body = '';
                    if (s.status === STATUS.YOUR_TURN) {
                        body = s.reason ? `Your Turn (${s.reason}) • ${subject}` : `Your Turn • ${subject}`;
                    } else if (s.status === STATUS.BURN) {
                        body = s.reason ? `Burn: ${s.reason} • ${subject}` : `Burn • ${subject}`;
                    } else if (s.status === STATUS.DONE) {
                        body = `Done • ${subject}`;
                    }

                    try {
                        Main.notify(title, body);
                    } catch (e) {}

                    this._notifyCache.sessions[sid] = {
                        lastStatus: s.status,
                        notifiedStatus: s.status,
                        notifiedAt: Date.now(),
                    };
                }
            } else {
                const currentNotified = (s.status === STATUS.COOKING) ? null : (cached ? cached.notifiedStatus : null);
                if (!cached || cached.lastStatus !== s.status || cached.notifiedStatus !== currentNotified) {
                    this._notifyCache.sessions[sid] = {
                        lastStatus: s.status,
                        notifiedStatus: currentNotified,
                        notifiedAt: cached ? cached.notifiedAt : null,
                    };
                }
            }
        }

        if (this._isFirstScan) {
            this._isFirstScan = false;
        }

        // ponytail: prune missing sessions immediately, upgrade to ttl cache if ghost sessions need tracking
        for (const sid of Object.keys(this._notifyCache.sessions)) {
            if (!activeIds.has(sid)) {
                delete this._notifyCache.sessions[sid];
            }
        }

        this._saveNotifyCache();
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

        const doneNotifyItem = new PopupMenu.PopupSwitchMenuItem('Notify on Done', this._notifyDone);
        doneNotifyItem.connect('toggled', (item, state) => {
            this._notifyDone = state;
            this._saveNotifyCache(true);
        });
        this.menu.addMenuItem(doneNotifyItem);

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
            this._dirMonitor.cancel();
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
