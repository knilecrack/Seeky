// @ts-check
(function () {
    // @ts-expect-error acquireVsCodeApi is provided by the VS Code webview runtime
    const vscode = acquireVsCodeApi();

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
    const resultsList = /** @type {HTMLElement} */ (document.getElementById('results-list'));
    const resultsSpacer = /** @type {HTMLElement} */ (document.getElementById('results-spacer'));
    const resultsContent = /** @type {HTMLElement} */ (document.getElementById('results-content'));
    const titleLabel = /** @type {HTMLElement} */ (document.getElementById('title-label'));
    const resultCount = /** @type {HTMLElement} */ (document.getElementById('result-count'));
    
    const previewFilename = /** @type {HTMLElement} */ (document.getElementById('preview-filename'));
    const previewPath = /** @type {HTMLElement} */ (document.getElementById('preview-path'));
    const previewContent = /** @type {HTMLElement} */ (document.getElementById('preview-content'));
    
    const statusMode = /** @type {HTMLElement} */ (document.getElementById('status-mode'));

    // ── State ─────────────────────────────────────────────────────────────────
    let currentMode = 'grep';
    let grepMode = 'plain';
    let selectedIndex = -1;
    let navItems = [];
    let virtualItems = [];
    let totalHeight = 0;
    let searchTimeout = 0;
    const history = [];
    let historyIndex = -1;

    const RESULT_ITEM_HEIGHT = 42;
    const MODES = ['grep', 'files', 'recent', 'buffers', 'symbols'];

    // ── Mode / Focus Management ───────────────────────────────────────────────
    searchInput.addEventListener('focus', () => {
        statusMode.textContent = '-- INSERT --';
        statusMode.style.color = 'var(--accent)';
    });

    searchInput.addEventListener('blur', () => {
        statusMode.textContent = '-- NORMAL --';
        statusMode.style.color = 'var(--text-muted)';
    });

    searchInput.focus();

    window.addEventListener('mousedown', (e) => {
        if (e.target !== searchInput && !/** @type {HTMLElement} */(e.target).closest('.result-item')) {
            setTimeout(() => searchInput.focus(), 10);
        }
    });

    // ── Search Logic ──────────────────────────────────────────────────────────
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(triggerSearch, 150);
    });

    function triggerSearch() {
        const query = searchInput.value;
        if (!query.trim() && !['recent', 'buffers', 'symbols'].includes(currentMode)) {
            renderResults([]);
            return;
        }
        if (query.trim() && history[0] !== query) {
            history.unshift(query);
            if (history.length > 50) history.pop();
        }
        historyIndex = -1;
        resultCount.textContent = '...';
        vscode.postMessage({ command: 'search', query, mode: currentMode, grepMode });
    }

    // ── Render Results ────────────────────────────────────────────────────────
    function renderResults(items, capped = false, duration = null) {
        navItems = [];
        virtualItems = [];
        let currentTop = 0;
        
        const oldSelectedIndex = selectedIndex;

        if (items.length === 0) {
            selectedIndex = -1;
            resultCount.textContent = '0 / 0';
            resultsSpacer.style.height = '0px';
            resultsContent.innerHTML = '';
            clearPreview();
            return;
        }

        resultCount.textContent = `${items.length}${capped ? '+' : ''}`;

        items.forEach((item, i) => {
            navItems.push({ type: 'match', item });
            virtualItems.push({ type: 'match', data: item, index: i, top: currentTop, height: RESULT_ITEM_HEIGHT });
            currentTop += RESULT_ITEM_HEIGHT;
        });

        totalHeight = currentTop;
        
        // Reset selection on filter update
        selectedIndex = items.length > 0 ? 0 : -1;
        resultsList.scrollTop = 0;

        refreshVirtualList();

        if (navItems.length > 0 && selectedIndex >= 0) {
            updatePreviewInfo(navItems[selectedIndex].item);
        }
    }

    resultsList.addEventListener('scroll', refreshVirtualList);

    function refreshVirtualList() {
        const scrollTop = resultsList.scrollTop;
        const viewportHeight = resultsList.clientHeight;
        const buffer = 10;

        let startIdx = virtualItems.findIndex(item => item.top + item.height > scrollTop);
        if (startIdx === -1) startIdx = 0;
        startIdx = Math.max(0, startIdx - buffer);

        let endIdx = virtualItems.findIndex(item => item.top > scrollTop + viewportHeight);
        if (endIdx === -1) endIdx = virtualItems.length - 1;
        endIdx = Math.min(virtualItems.length - 1, endIdx + buffer);

        const visibleItems = virtualItems.slice(startIdx, endIdx + 1);
        
        resultsSpacer.style.height = `${totalHeight}px`;
        resultsContent.style.transform = `translateY(${virtualItems[startIdx]?.top || 0}px)`;

        resultsContent.innerHTML = visibleItems.map(v => {
            const match = v.data;
            const sel = v.index === selectedIndex ? ' selected result-selected' : '';
            const { fname, dir } = splitPath(match.relativePath || '');
            
            let matchHtml = '';
            if (currentMode === 'grep' || currentMode === 'symbols') {
                const highlight = highlightText(match.text.trimStart(), searchInput.value);
                matchHtml = `<div class="result-match-row">
                    <span class="result-line-num">${match.line}</span>
                    <span class="result-colon">:</span>
                    <span class="result-text truncate">${highlight}</span>
                </div>`;
            }

            return `<div class="result-item${sel}" data-index="${v.index}" style="height:${v.height}px">
                <div class="result-file-row">
                    <i class="codicon codicon-file-code result-file-icon"></i>
                    <span class="result-filename truncate">${escHtml(fname)}</span>
                    <span class="result-path truncate">${escHtml(dir)}</span>
                </div>
                ${matchHtml}
            </div>`;
        }).join('');

        resultsContent.querySelectorAll('.result-item').forEach((el) => {
            el.addEventListener('click', () => selectResult(parseInt(/** @type {HTMLElement} */(el).dataset.index, 10)));
            el.addEventListener('dblclick', () => {
                const idx = parseInt(/** @type {HTMLElement} */(el).dataset.index, 10);
                selectResult(idx);
                if (navItems[idx]) { openResult(navItems[idx].item); }
            });
        });
    }

    function selectResult(index) {
        if (navItems.length === 0) { return; }
        selectedIndex = Math.max(0, Math.min(navItems.length - 1, index));
        refreshVirtualList();
        scrollToSelected();
        if (navItems[selectedIndex]) {
            updatePreviewInfo(navItems[selectedIndex].item);
        }
    }

    function scrollToSelected() {
        const item = virtualItems.find(v => v.index === selectedIndex);
        if (!item) return;
        
        const scrollTop = resultsList.scrollTop;
        const viewportHeight = resultsList.clientHeight;
        
        const itemTop = item.top;
        const itemBottom = itemTop + item.height;

        if (itemTop < scrollTop) {
            resultsList.scrollTop = itemTop;
        } else if (itemBottom > scrollTop + viewportHeight) {
            resultsList.scrollTop = itemBottom - viewportHeight;
        }
    }

    function clearPreview() {
        previewFilename.textContent = '';
        previewPath.textContent = '';
        previewContent.innerHTML = '';
    }

    function updatePreviewInfo(item) {
        const { fname, dir } = splitPath(item.relativePath || '');
        previewFilename.textContent = fname;
        previewPath.textContent = dir;
        vscode.postMessage({ command: 'preview', item });
    }

    // ── Syntax Highlighting ───────────────────────────────────────────────────
    const KWS = new Set(['const', 'var', 'fn', 'pub', 'return', 'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'defer', 'errdefer', 'comptime', 'inline', 'void', 'bool', 'usize', 'true', 'false', 'null', 'undefined', 'error', 'struct', 'enum', 'union', 'orelse', 'unreachable', 'break', 'continue']);

    function applySyntaxHighlighting(escapedText) {
        // 1. Strings: &quot;...&quot;
        let html = escapedText.replace(/&quot;.*?&quot;/g, match => `<span class="syn-str">${match}</span>`);
        
        // 2. Line Comments: // ...
        html = html.replace(/\/\/.*$/g, match => `<span class="syn-com">${match}</span>`);
        
        // 3. Keywords & Numbers (not inside spans to be safe, but a simple regex works for this prototype)
        // We use a simple token replacer that ignores anything inside a span.
        const tokenRegex = /(<[^>]+>)|(\b[a-zA-Z_]\w*\b)|(\b\d+\b)/g;
        html = html.replace(tokenRegex, (match, tag, word, num) => {
            if (tag) return match;
            if (num) return `<span class="syn-num">${match}</span>`;
            if (word && KWS.has(word)) return `<span class="syn-kw">${match}</span>`;
            return match;
        });

        return html;
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
        let html = ``;
        for (let i = 0; i < lines.length; i++) {
            const lineNum = data.startLine + i;
            const isTarget = lineNum === data.targetLine;
            
            // Only highlight syntax if it's the target line for this spec
            let textHtml = escHtml(lines[i]);
            textHtml = applySyntaxHighlighting(textHtml);

            html += `<div class="preview-line${isTarget ? ' matched' : ''}">
                <span class="preview-line-num">${lineNum}</span>
                <span class="preview-line-text">${textHtml}</span>
            </div>`;
        }
        previewContent.innerHTML = html;
        
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
                vscode.postMessage({ command: 'close' });
                break;
            // Mode switching via Tab is removed per spec, but could be added back
        }
    });

    function openResult(item) {
        vscode.postMessage({ command: 'open', item, sideBySide: false, dispose: true });
    }

    function setMode(mode) {
        currentMode = mode;
        const labels = {
            'grep': 'Live Grep',
            'files': 'File Finder',
            'recent': 'Recent Files',
            'buffers': 'Open Buffers',
            'symbols': 'Document Symbols'
        };
        titleLabel.textContent = labels[mode] || mode;
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
                searchInput.focus();
                break;
        }
    });

    // ── Utils ─────────────────────────────────────────────────────────────────
    function splitPath(relativePath) {
        const parts = relativePath.replace(/\\/g, '/').split('/');
        const fname = parts.pop() || relativePath;
        const dir = parts.join('/');
        return { fname, dir };
    }

    function escHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function highlightText(text, query) {
        if (!query) { return escHtml(text); }
        try {
            const pattern = escapeRegex(query).split('').join('.*?'); // Simple fuzzy simulation
            const re = new RegExp(pattern, 'gi');
            // Advanced fuzzy highlighting is complex to do accurately with simple regex.
            // For now, we fallback to standard highlight if simple match works, otherwise just text.
            const exactRe = new RegExp(escapeRegex(query), 'gi');
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
