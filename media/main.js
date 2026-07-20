// @ts-check
(function () {
    // @ts-expect-error acquireVsCodeApi is provided by the VS Code webview runtime
    const vscode = acquireVsCodeApi();

    window.addEventListener('error', (e) => {
        document.body.innerHTML += `<div style="position:absolute;top:0;left:0;z-index:9999;background:red;color:white;padding:10px;">Error: ${e.message} <br> ${e.filename}:${e.lineno}</div>`;
    });

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
    const resultsList = /** @type {HTMLElement} */ (document.getElementById('results-list'));
    const resultsContent = /** @type {HTMLElement} */ (document.getElementById('results-content'));
    const titleLabel = /** @type {HTMLElement} */ (document.getElementById('title-label'));
    const resultCount = /** @type {HTMLElement} */ (document.getElementById('result-count'));
    const regexToggle = /** @type {HTMLElement} */ (document.getElementById('regex-toggle'));

    const previewFilename = /** @type {HTMLElement} */ (document.getElementById('preview-filename'));
    const previewPath = /** @type {HTMLElement} */ (document.getElementById('preview-path'));
    const previewContent = /** @type {HTMLElement} */ (document.getElementById('preview-content'));

    const statusMode = /** @type {HTMLElement} */ (document.getElementById('status-mode'));
    const colResizer = /** @type {HTMLElement} */ (document.getElementById('col-resizer'));
    const resultsCol = /** @type {HTMLElement} */ (document.getElementById('results-col'));

    // Create Vim Block Cursor
    const vimCursor = document.createElement('div');
    vimCursor.className = 'vim-block-cursor';
    vimCursor.style.display = 'none';
    if (resultsList) {
        resultsList.parentElement.appendChild(vimCursor);
    }

    // ── State ─────────────────────────────────────────────────────────────────
    let currentMode = window.INITIAL_MODE || 'grep';
    let grepMode = 'fuzzy';
    let selectedIndex = -1;
    /** @type {HTMLElement|null} */
    let selectedElement = null;
    let navItems = [];
    const history = [];
    let lastEscapeTimestamp = 0;

    const DOUBLE_ESCAPE_WINDOW_MS = 380;

    if (regexToggle) {
        regexToggle.addEventListener('click', () => {
            searchInput.focus();
        });
    }

    // ── Resizer Logic ─────────────────────────────────────────────────────────
    let isResizing = false;
    if (colResizer && resultsCol) {
        colResizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            colResizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const container = document.getElementById('content-area');
            if (!container) return;
            const containerWidth = container.offsetWidth;
            const newWidthPercent = (e.clientX / containerWidth) * 100;
            if (newWidthPercent > 15 && newWidthPercent < 80) {
                document.documentElement.style.setProperty('--results-width', `${newWidthPercent}%`);
            }
        });

        window.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                colResizer.classList.remove('dragging');
                document.body.style.cursor = '';
            }
        });
    }

    function parseGrepQuery(rawQuery) {
        const grepModeByPrefix = {
            'f': 'fuzzy',
            'p': 'plain',
            'r': 'regex',
        };

        // Prefix commands are recognized only as: "\\x <query>".
        const prefixMatch = rawQuery.match(/^\\([fpr])(?:\s+([\s\S]*))?$/);
        if (!prefixMatch) {
            return { grepMode: 'fuzzy', searchQuery: rawQuery, waitingForInput: false };
        }

        const [, prefix, remainder] = prefixMatch;
        const trimmedRemainder = (remainder || '').trim();

        return {
            grepMode: grepModeByPrefix[prefix] || 'fuzzy',
            searchQuery: trimmedRemainder,
            waitingForInput: !trimmedRemainder,
        };
    }

    function updateRegexToggleUI() {
        if (!regexToggle) return;
        const icon = regexToggle.querySelector('i');
        if (!icon) return;

        if (grepMode === 'regex') {
            regexToggle.classList.add('active');
            regexToggle.title = 'Regex Mode (prefix query with \\r)';
            icon.className = 'codicon codicon-regex';
        } else if (grepMode === 'fuzzy') {
            regexToggle.classList.add('active');
            regexToggle.title = 'Fuzzy Mode (default, or prefix query with \\f)';
            icon.className = 'codicon codicon-sparkle';
        } else {
            regexToggle.classList.remove('active');
            regexToggle.title = 'Plain Text Mode (prefix query with \\p)';
            icon.className = 'codicon codicon-case-sensitive';
        }
    }
    updateRegexToggleUI();

    const PATH_TRUNCATE_LEN = 32;
    const MODES = ['grep', 'files', 'recent', 'buffers', 'symbols', 'workspace-symbols', 'git-modified'];

    // ── Mode / Focus Management ───────────────────────────────────────────────
    let isInsertMode = true;

    function updateVimCursor() {
        if (!selectedElement || isInsertMode) {
            vimCursor.style.display = 'none';
            return;
        }
        vimCursor.style.display = 'block';
        const rect = selectedElement.getBoundingClientRect();
        const parentRect = resultsList.parentElement.getBoundingClientRect();
        
        vimCursor.style.top = `${rect.top - parentRect.top}px`;
        vimCursor.style.left = `${rect.left - parentRect.left}px`;
        vimCursor.style.width = `${rect.width}px`;
        vimCursor.style.height = `${rect.height}px`;
    }

    searchInput.addEventListener('focus', () => {
        isInsertMode = true;
        statusMode.textContent = '-- INSERT --';
        statusMode.style.color = 'var(--accent)';
        updateVimCursor();
    });

    searchInput.addEventListener('blur', () => {
        isInsertMode = false;
        statusMode.textContent = '-- NORMAL --';
        statusMode.style.color = 'var(--text-muted)';
        updateVimCursor();
    });

    // Setup mode tabs click events
    document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const mode = tab.getAttribute('data-mode');
            if (mode) {
                setMode(mode);
                searchInput.focus();
            }
        });
    });

    // Initialize UI based on starting mode
    setMode(currentMode);
    if (window.INITIAL_QUERY) {
        searchInput.value = window.INITIAL_QUERY;
        triggerSearch();
    }

    // Ensure focus on load
    searchInput.focus();
    setTimeout(() => {
        searchInput.focus();
        // Force slide active tab geometry on load once rendered
        const activeTab = document.querySelector(`.mode-tab[data-mode="${currentMode}"]`);
        if (activeTab) {
            const container = document.getElementById('mode-tabs-container');
            const slider = container ? container.querySelector('.tab-slider') : null;
            if (slider) {
                slider.style.transform = `translateX(${activeTab.offsetLeft}px)`;
                slider.style.width = `${activeTab.offsetWidth}px`;
            }
        }
    }, 50);

    const focusSearchInput = () => {
        requestAnimationFrame(() => {
            searchInput.focus();
            searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
        });
    };

    window.addEventListener('focus', focusSearchInput);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            focusSearchInput();
        }
    });

    window.addEventListener('mousedown', (e) => {
        if (e.target !== searchInput && !/** @type {HTMLElement} */(e.target).closest('.result-item') && !/** @type {HTMLElement} */(e.target).closest('.mode-tab')) {
            setTimeout(() => searchInput.focus(), 10);
        }
    });

    // Re-align slider on window resize
    window.addEventListener('resize', () => {
        const activeTab = document.querySelector(`.mode-tab[data-mode="${currentMode}"]`);
        if (activeTab) {
            const container = document.getElementById('mode-tabs-container');
            const slider = container ? container.querySelector('.tab-slider') : null;
            if (slider) {
                slider.style.transform = `translateX(${activeTab.offsetLeft}px)`;
                slider.style.width = `${activeTab.offsetWidth}px`;
            }
        }
    });

    // ── Search Logic ──────────────────────────────────────────────────────────
    let searchDebounceTimeout = null;

    searchInput.addEventListener('input', () => {
        if (searchDebounceTimeout) clearTimeout(searchDebounceTimeout);
        searchDebounceTimeout = setTimeout(() => {
            triggerSearch();
        }, 50);
    });

    function triggerSearch() {
        const rawQuery = searchInput.value;
        const grepConfig = currentMode === 'grep'
            ? parseGrepQuery(rawQuery)
            : { grepMode, searchQuery: rawQuery };
        grepMode = grepConfig.grepMode;
        updateRegexToggleUI();

        const query = grepConfig.searchQuery;
        if (currentMode === 'grep' && grepConfig.waitingForInput) {
            renderResults([]);
            return;
        }
        if (!query.trim() && !['recent', 'buffers', 'symbols', 'workspace-symbols', 'git-modified'].includes(currentMode)) {
            renderResults([]);
            return;
        }
        if (query.trim() && history[0] !== rawQuery) {
            history.unshift(rawQuery);
            if (history.length > 50) history.pop();
        }
        resultCount.textContent = '...';
        vscode.postMessage({ command: 'search', query, mode: currentMode, grepMode: grepConfig.grepMode });
    }

    function highlightRanges(text, ranges) {
        if (!ranges || ranges.length === 0) return escHtml(text);

        let result = '';
        let lastEnd = 0;

        for (const [start, end] of ranges) {
            // Ensure bounds are within string length just in case
            const s = Math.max(0, start);
            const e = Math.min(text.length, end);

            if (s > lastEnd) {
                result += escHtml(text.substring(lastEnd, s));
            }
            if (s < e) {
                result += `<mark class="fuzzy-match">${escHtml(text.substring(s, e))}</mark>`;
            }
            lastEnd = Math.max(lastEnd, e);
        }

        if (lastEnd < text.length) {
            result += escHtml(text.substring(lastEnd));
        }

        return result;
    }

    // ── Render Results ────────────────────────────────────────────────────────
    function renderResults(items, capped = false) {
        navItems = [];

        if (items.length === 0) {
            selectedIndex = -1;
            resultCount.textContent = '0 / 0';
            resultsContent.innerHTML = '';
            clearPreview();
            return;
        }

        resultCount.textContent = `${items.length}${capped ? '+' : ''}`;

        let html = '';
        items.forEach((item, i) => {
            navItems.push({ type: 'match', item });
            const isFirstInGroup = currentMode !== 'grep' || i === 0 || item.relativePath !== items[i - 1]?.relativePath;
            
            const sel = i === selectedIndex ? ' selected result-selected' : '';
            const { fname, dir } = splitPath(item.relativePath || '');
            const truncatedDir = truncatePath(dir, PATH_TRUNCATE_LEN);

            let matchHtml = '';
            let hlFname = escHtml(fname || '');

            if (currentMode === 'grep' || currentMode === 'symbols' || currentMode === 'workspace-symbols') {
                let highlight;
                const matchText = item.text || '';
                if (item.matchRanges && item.matchRanges.length > 0) {
                    highlight = highlightRanges(matchText.trimStart(), item.matchRanges);
                } else {
                    highlight = highlightText(matchText.trimStart(), searchInput.value);
                }

                matchHtml = `<div class="result-match-row">
                    <span class="result-line-num">${item.line}</span>
                    <span class="result-colon">:</span>
                    <span class="result-text truncate">${highlight}</span>
                </div>`;
            } else {
                hlFname = highlightText(fname || '', searchInput.value);
            }

            if (currentMode === 'grep' && !isFirstInGroup) {
                html += `<div class="result-item result-item-match-only${sel}" data-index="${i}">
                    ${matchHtml}
                </div>`;
                return;
            }

            let iconHtml = '';
            if ((currentMode === 'symbols' || currentMode === 'workspace-symbols') && item.kind) {
                const iconClass = getSymbolIcon(item.kind);
                iconHtml = `<i class="codicon ${iconClass} result-file-icon"></i>`;
            } else {
                const iconPathRaw = window.getRosePineIcon ? window.getRosePineIcon(fname || '') : 'icons/file.svg';
                const iconPath = iconPathRaw.replace(/^(\.\/|\/)/, '');
                iconHtml = `<img src="${window.MEDIA_URI}/${iconPath}" class="result-file-icon" />`;
            }

            let containerHtml = '';
            if ((currentMode === 'symbols' || currentMode === 'workspace-symbols') && item.containerName) {
                containerHtml = `<span class="result-path" style="margin-right: 2px;">${escHtml(item.containerName)} ›</span>`;
            }

            let kindBadgeHtml = '';
            if ((currentMode === 'symbols' || currentMode === 'workspace-symbols') && item.kind) {
                kindBadgeHtml = `<span class="result-path" style="margin-left: auto; opacity: 0.7; font-size: 9px;">${escHtml(item.kind)}</span>`;
            }

            html += `<div class="result-item${sel}" data-index="${i}">
                <div class="result-file-row">
                    ${iconHtml}
                    ${containerHtml}
                    <span class="result-filename truncate">${hlFname}</span>
                    <span class="result-path truncate">${escHtml(truncatedDir)}</span>
                    ${kindBadgeHtml}
                </div>
                ${matchHtml}
            </div>`;
        });
        
        resultsContent.innerHTML = html;

        selectedIndex = items.length > 0 ? 0 : -1;
        // Cache the initially-selected element for O(1) swaps in selectResult
        selectedElement = selectedIndex >= 0
            ? resultsContent.querySelector('.result-item[data-index="0"]')
            : null;
        if (selectedElement) {
            selectedElement.classList.add('selected', 'result-selected');
        }
        resultsList.scrollTop = 0;

        if (navItems.length > 0 && selectedIndex >= 0) {
            updatePreviewInfo(navItems[selectedIndex].item);
        }
    }

    function selectResult(index) {
        if (navItems.length === 0) { return; }
        selectedIndex = Math.max(0, Math.min(navItems.length - 1, index));

        // O(1) swap: remove classes from the old element, add to the new one
        if (selectedElement) {
            selectedElement.classList.remove('selected', 'result-selected');
        }
        const nextEl = resultsContent.querySelector(`.result-item[data-index="${selectedIndex}"]`);
        if (nextEl) {
            nextEl.classList.add('selected', 'result-selected');
            selectedElement = nextEl;
        }

        scrollToSelected();
        if (navItems[selectedIndex]) {
            updatePreviewInfo(navItems[selectedIndex].item);
        }
        updateVimCursor();
    }

    resultsContent.addEventListener('click', (e) => {
        const itemEl = e.target.closest('.result-item');
        if (itemEl) {
            selectResult(parseInt(itemEl.dataset.index, 10));
        }
    });

    resultsContent.addEventListener('dblclick', (e) => {
        const itemEl = e.target.closest('.result-item');
        if (itemEl) {
            const idx = parseInt(itemEl.dataset.index, 10);
            selectResult(idx);
            if (navItems[idx]) { openResult(navItems[idx].item); }
        }
    });

    function scrollToSelected() {
        const selectedEl = resultsContent.querySelector(`.result-item[data-index="${selectedIndex}"]`);
        if (!selectedEl) return;

        const scrollTop = resultsList.scrollTop;
        const viewportHeight = resultsList.clientHeight;

        const itemTop = selectedEl.offsetTop;
        const itemBottom = itemTop + selectedEl.offsetHeight;

        if (itemTop < scrollTop) {
            resultsList.scrollTop = itemTop;
        } else if (itemBottom > scrollTop + viewportHeight) {
            resultsList.scrollTop = itemBottom - viewportHeight;
        }
    }

    function clearPreview() {
        const watermarkHtml = `<div id="watermark-preview">
            <div class="watermark-card">
                <i class="codicon codicon-telescope animate-pulse"></i>
                <h2>Seeky Modal Search</h2>
                <div class="watermark-shortcuts">
                    <span><kbd>Tab</kbd> Cycle Modes</span>
                    <span><kbd>\\f</kbd> fuzzy <kbd>\\p</kbd> plain <kbd>\\r</kbd> regex</span>
                    <span><kbd>↑</kbd> / <kbd>↓</kbd> Navigate</span>
                    <span><kbd>Enter</kbd> Open Result</span>
                </div>
            </div>
        </div>`;
        previewFilename.textContent = '';
        previewPath.textContent = '';
        previewContent.innerHTML = watermarkHtml;

        const badgeGit = document.getElementById('badge-git');
        const badgeSize = document.getElementById('badge-size');
        const badgeMtime = document.getElementById('badge-mtime');
        if (badgeGit) badgeGit.classList.add('hidden');
        if (badgeSize) badgeSize.classList.add('hidden');
        if (badgeMtime) badgeMtime.classList.add('hidden');
    }

    let previewDebounceTimeout = null;

    function updatePreviewInfo(item) {
        const { fname, dir } = splitPath(item.relativePath || '');
        previewFilename.textContent = fname;
        previewPath.textContent = dir;
        
        if (previewDebounceTimeout) clearTimeout(previewDebounceTimeout);
        previewDebounceTimeout = setTimeout(() => {
            vscode.postMessage({ command: 'preview', item });
        }, 75);
    }

    // ── Syntax Highlighting ───────────────────────────────────────────────────
    function formatSize(bytes) {
        if (bytes === undefined || bytes === null) return '';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function formatRelativeTime(mtimeMs) {
        if (!mtimeMs) return '';
        const diff = Date.now() - mtimeMs;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 10) return 'just now';
        if (seconds < 60) return `${seconds}s ago`;
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days === 1) return 'yesterday';
        return `${days} days ago`;
    }

    function renderPreview(data) {
        const currentItem = navItems[selectedIndex]?.item;
        if (!currentItem || currentItem.file !== data.item.file || (currentItem.type === 'grep' && currentItem.line !== data.item.line)) {
            return;
        }

        if (!data.content) {
            previewContent.innerHTML = ``;
            return;
        }

        const lines = data.content.split('\n');
        const isDiff = data.content.startsWith('diff --git') || /^(---|\\+\\+\\+) /.test(data.content);
        let html = ``;
        for (let i = 0; i < lines.length; i++) {
            const lineNum = data.startLine + i;
            const isTarget = lineNum === data.targetLine;

            if (isDiff) {
                const line = lines[i];
                const textHtml = escHtml(line);
                const diffClass = (() => {
                    if (line.startsWith('@@')) return ' diff-hunk';
                    if (line.startsWith('+') && !line.startsWith('+++')) return ' diff-add';
                    if (line.startsWith('-') && !line.startsWith('---')) return ' diff-remove';
                    return '';
                })();
                html += `<div class="preview-line${isTarget ? ' matched' : ''}${diffClass}">
                    <span class="preview-line-num">${lineNum}</span>
                    <span class="preview-line-text">${textHtml}</span>
                </div>`;
            } else {
                // Backend provides Shiki highlighted HTML
                const textHtml = lines[i];
                html += `<div class="preview-line${isTarget ? ' matched' : ''}">
                    <span class="preview-line-num">${lineNum}</span>
                    <span class="preview-line-text">${textHtml}</span>
                </div>`;
            }
        }
        previewContent.innerHTML = html;

        // Render preview ribbon stats
        const badgeGit = document.getElementById('badge-git');
        const badgeSize = document.getElementById('badge-size');
        const badgeMtime = document.getElementById('badge-mtime');

        if (data.stats) {
            const stats = data.stats;

            if (badgeGit && stats.gitStatus && stats.gitStatus !== 'unmodified' && stats.gitStatus !== 'none') {
                badgeGit.className = `meta-badge git-${stats.gitStatus}`;
                let icon = 'diff-ignored';
                let text = stats.gitStatus;
                if (stats.gitStatus === 'added') { icon = 'diff-added'; text = 'Added'; }
                else if (stats.gitStatus === 'modified') { icon = 'diff-modified'; text = 'Modified'; }
                else if (stats.gitStatus === 'untracked') { icon = 'diff-added'; text = 'Untracked'; }
                badgeGit.innerHTML = `<i class="codicon codicon-${icon}"></i><span>${text}</span>`;
                badgeGit.classList.remove('hidden');
            } else if (badgeGit) {
                badgeGit.classList.add('hidden');
            }

            if (badgeSize && stats.size !== undefined) {
                badgeSize.className = 'meta-badge file-size';
                badgeSize.innerHTML = `<i class="codicon codicon-database"></i><span>${formatSize(stats.size)}</span>`;
                badgeSize.classList.remove('hidden');
            } else if (badgeSize) {
                badgeSize.classList.add('hidden');
            }

            if (badgeMtime && stats.mtime) {
                badgeMtime.className = 'meta-badge time-stamp';
                badgeMtime.innerHTML = `<i class="codicon codicon-history"></i><span>${formatRelativeTime(stats.mtime)}</span>`;
                badgeMtime.classList.remove('hidden');
            } else if (badgeMtime) {
                badgeMtime.classList.add('hidden');
            }
        } else {
            if (badgeGit) badgeGit.classList.add('hidden');
            if (badgeSize) badgeSize.classList.add('hidden');
            if (badgeMtime) badgeMtime.classList.add('hidden');
        }

        requestAnimationFrame(() => {
            const matched = previewContent.querySelector('.preview-line.matched');
            if (matched) {
                // Scroll the matched line to the middle of the preview pane
                const containerH = previewContent.clientHeight;
                previewContent.scrollTop = /** @type {HTMLElement} */(matched).offsetTop - (containerH / 2);
            }
        });
    }

    // ── Input & Keybindings ───────────────────────────────────────────────────
    searchInput.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                selectResult(selectedIndex + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                selectResult(selectedIndex - 1);
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && navItems[selectedIndex]) {
                    openResult(navItems[selectedIndex].item);
                }
                break;
            case 'Escape':
                e.preventDefault();
                {
                    const now = Date.now();
                    if (now - lastEscapeTimestamp <= DOUBLE_ESCAPE_WINDOW_MS) {
                        lastEscapeTimestamp = 0;
                        vscode.postMessage({ command: 'close' });
                    } else {
                        lastEscapeTimestamp = now;
                        statusMode.textContent = '-- ESC AGAIN TO CLOSE --';
                        statusMode.style.color = 'var(--text-muted)';
                    }
                }
                break;
            case 'Tab':
                e.preventDefault();
                {
                    const dir = e.shiftKey ? -1 : 1;
                    const nextIdx = (MODES.indexOf(currentMode) + dir + MODES.length) % MODES.length;
                    setMode(MODES[nextIdx]);
                }
                break;
        }
    });

    function openResult(item) {
        vscode.postMessage({ command: 'open', item, sideBySide: false, dispose: true });
    }

    function setMode(mode) {
        currentMode = mode;
        lastEscapeTimestamp = 0;
        const labels = {
            'grep': 'Live Grep',
            'files': 'File Finder',
            'git-modified': 'Git Modified Files',
            'recent': 'Recent Files',
            'buffers': 'Open Buffers',
            'symbols': 'Document Symbols',
            'workspace-symbols': 'Workspace Symbols'
        };
        if (titleLabel) {
            titleLabel.textContent = labels[mode] || mode;
        }
        if (regexToggle) {
            regexToggle.style.display = mode === 'grep' ? 'flex' : 'none';
        }

        // Update tabs active state & slider position
        document.querySelectorAll('.mode-tab').forEach(tab => {
            if (tab.getAttribute('data-mode') === mode) {
                tab.classList.add('active');

                const container = document.getElementById('mode-tabs-container');
                const slider = container ? container.querySelector('.tab-slider') : null;
                if (slider) {
                    requestAnimationFrame(() => {
                        slider.style.transform = `translateX(${tab.offsetLeft}px)`;
                        slider.style.width = `${tab.offsetWidth}px`;
                    });
                }
            } else {
                tab.classList.remove('active');
            }
        });

        triggerSearch();
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'results': renderResults(msg.items, msg.capped, msg.duration); break;
            case 'preview': renderPreview(msg); break;
            case 'setMode': setMode(msg.mode); break;
            case 'setQuery':
                if (msg.mode) { setMode(msg.mode); }
                searchInput.value = msg.query || '';
                searchInput.focus();
                triggerSearch();
                break;
            case 'focus':
                focusSearchInput();
                break;
        }
    });

    // ── Utils ─────────────────────────────────────────────────────────────────
    function getSymbolIcon(kind) {
        switch (kind) {
            case 'File': return 'codicon-symbol-file';
            case 'Module': case 'Namespace': case 'Package': return 'codicon-symbol-namespace';
            case 'Class': return 'codicon-symbol-class';
            case 'Method': return 'codicon-symbol-method';
            case 'Property': case 'Field': return 'codicon-symbol-property';
            case 'Constructor': return 'codicon-symbol-method';
            case 'Enum': return 'codicon-symbol-enum';
            case 'Interface': return 'codicon-symbol-interface';
            case 'Function': return 'codicon-symbol-function';
            case 'Variable': return 'codicon-symbol-variable';
            case 'Constant': return 'codicon-symbol-constant';
            case 'String': return 'codicon-symbol-string';
            case 'Number': return 'codicon-symbol-numeric';
            case 'Boolean': return 'codicon-symbol-boolean';
            case 'Array': return 'codicon-symbol-array';
            case 'Object': return 'codicon-symbol-namespace';
            case 'Key': return 'codicon-symbol-key';
            case 'Null': return 'codicon-symbol-null';
            case 'EnumMember': return 'codicon-symbol-enum-member';
            case 'Struct': return 'codicon-symbol-struct';
            case 'Event': return 'codicon-symbol-event';
            case 'Operator': return 'codicon-symbol-operator';
            case 'TypeParameter': return 'codicon-symbol-type-parameter';
            default: return 'codicon-symbol-misc';
        }
    }

    function splitPath(relativePath) {
        const parts = relativePath.replace(/\\/g, '/').split('/');
        const fname = parts.pop() || relativePath;
        const dir = parts.join('/');
        return { fname, dir };
    }

    function truncatePath(path, maxLen) {
        if (path.length <= maxLen) return path;
        return `\u2026${path.slice(-(maxLen - 1))}`;
    }

    const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    function escHtml(str) {
        return str.replace(/[&<>"]/g, c => _escMap[c]);
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function highlightText(text, query) {
        if (!query) { return escHtml(text); }
        const effectiveQuery = currentMode === 'grep' ? parseGrepQuery(query).searchQuery : query;
        if (!effectiveQuery) { return escHtml(text); }
        try {
            // Advanced fuzzy highlighting is complex to do accurately with simple regex.
            // For now, we fallback to standard highlight if simple match works, otherwise just text.
            const exactRe = new RegExp(escapeRegex(effectiveQuery), 'gi');
            let result = '';
            let lastIndex = 0;
            for (let match = exactRe.exec(text); match !== null; match = exactRe.exec(text)) {
                result += escHtml(text.slice(lastIndex, match.index));
                result += `<mark class="fuzzy-match">${escHtml(match[0])}</mark>`;
                lastIndex = match.index + match[0].length;
                if (match[0].length === 0) { exactRe.lastIndex++; }
            }
            result += escHtml(text.slice(lastIndex));
            return result || escHtml(text);
        } catch (_) {
            return escHtml(text);
        }
    }
}());
