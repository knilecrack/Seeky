// @ts-check
(function () {
    // @ts-expect-error acquireVsCodeApi is provided by the VS Code webview runtime
    const vscode = acquireVsCodeApi();

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
    const resultsList = /** @type {HTMLElement} */ (document.getElementById('results-list'));
    const resultsSpacer = /** @type {HTMLElement} */ (document.getElementById('results-spacer'));
    const resultsContent = /** @type {HTMLElement} */ (document.getElementById('results-content'));
    const resultsEmpty = /** @type {HTMLElement} */ (document.getElementById('results-empty'));
    const resultsLabel = /** @type {HTMLElement} */ (document.getElementById('results-label'));
    const infoContent = /** @type {HTMLElement} */ (document.getElementById('info-content'));
    const previewLabel = /** @type {HTMLElement} */ (document.getElementById('preview-label'));
    const previewContent = /** @type {HTMLElement} */ (document.getElementById('preview-content'));
    const btnRegex = /** @type {HTMLButtonElement} */ (document.getElementById('btn-regex'));
    const resultCount = /** @type {HTMLElement} */ (document.getElementById('result-count'));

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

    const HEADER_HEIGHT = 32;
    const MATCH_HEIGHT = 28;
    const FILE_ITEM_HEIGHT = 28;
    const GROUP_GAP = 16;

    const MODES = ['grep', 'files', 'recent', 'buffers', 'symbols'];

    function getFileIcon(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const icons = {
            'js': 'vscode-js',
            'ts': 'vscode-ts',
            'json': 'json',
            'md': 'markdown',
            'css': 'css',
            'html': 'html',
            'rs': 'rust',
            'py': 'python',
            'go': 'go',
            'c': 'symbol-method',
            'cpp': 'symbol-method',
            'h': 'symbol-method',
            'txt': 'file-text',
            'png': 'file-media',
            'jpg': 'file-media',
            'svg': 'file-media',
            'sh': 'terminal'
        };
        return icons[ext] || 'file';
    }

    // ── Initial focus + focus management ──────────────────────────────────────
    searchInput.focus();

    // Force focus back to input on almost any interaction to keep search fluid
    window.addEventListener('mousedown', (e) => {
        if (e.target !== searchInput && !/** @type {HTMLElement} */(e.target).closest('button')) {
            // We use a small delay so that the browser can process the click on the result item first
            setTimeout(() => searchInput.focus(), 10);
        }
    });

    resultsList.addEventListener('scroll', () => {
        refreshVirtualList();
    });

    // ── Mode/Regex toggle ─────────────────────────────────────────────────────
    btnRegex.addEventListener('click', () => toggleRegex());

    function toggleRegex() {
        grepMode = grepMode === 'plain' ? 'regex' : 'plain';
        btnRegex.className = btnRegex.className.replace(/btn-(active|inactive)/g, '') + (grepMode === 'regex' ? ' btn-active' : ' btn-inactive');
        triggerSearch();
    }

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
        resultCount.textContent = 'Searching…';
        vscode.postMessage({ command: 'search', query, mode: currentMode, grepMode });
    }

    // ── Render results ────────────────────────────────────────────────────────
    function renderResults(items, capped = false, duration = null) {
        navItems = [];
        virtualItems = [];
        let currentTop = 0;
        
        const oldSelectedIndex = selectedIndex;

        if (items.length === 0) {
            selectedIndex = -1;
            resultCount.textContent = '';
            resultsSpacer.style.height = '0px';
            resultsContent.innerHTML = '';
            resultsEmpty.style.display = 'block';
            infoContent.innerHTML = `<div class="empty-state"><i class="codicon codicon-info" style="font-size:24px"></i><span>No details</span></div>`;
            previewLabel.textContent = 'Preview';
            previewContent.innerHTML = `<div class="empty-state"><i class="codicon codicon-go-to-file" style="font-size:32px"></i><span>No preview</span></div>`;
            return;
        }

        resultsEmpty.style.display = 'none';
        const dur = duration ? ` (${Math.round(duration)}ms)` : '';
        resultCount.textContent = `${items.length}${capped ? '+' : ''} matches${dur}`;

        if (currentMode === 'grep' || currentMode === 'symbols') {
            const groups = new Map();
            items.forEach(item => {
                const groupKey = item.file;
                if (!groups.has(groupKey)) {
                    groups.set(groupKey, { file: item.file, relativePath: item.relativePath, matches: [] });
                }
                groups.get(groupKey).matches.push(item);
            });

            let globalIdx = 0;
            groups.forEach((group) => {
                virtualItems.push({ type: 'header', data: group, top: currentTop, height: HEADER_HEIGHT });
                currentTop += HEADER_HEIGHT;
                
                group.matches.forEach((match) => {
                    navItems.push({ type: 'match', item: match });
                    virtualItems.push({ type: 'match', data: match, index: globalIdx, top: currentTop, height: MATCH_HEIGHT });
                    currentTop += MATCH_HEIGHT;
                    globalIdx++;
                });
                virtualItems.push({ type: 'gap', top: currentTop, height: GROUP_GAP });
                currentTop += GROUP_GAP;
            });
        } else {
            items.forEach((item, i) => {
                navItems.push({ type: 'match', item });
                virtualItems.push({ type: 'match', data: item, index: i, top: currentTop, height: FILE_ITEM_HEIGHT });
                currentTop += FILE_ITEM_HEIGHT;
            });
        }

        totalHeight = currentTop;
        
        if (oldSelectedIndex === -1 || items.length === 0) {
            selectedIndex = items.length > 0 ? 0 : -1;
            resultsList.scrollTop = 0;
        } else {
            selectedIndex = Math.min(oldSelectedIndex, navItems.length - 1);
        }

        refreshVirtualList();

        if (navItems.length > 0 && selectedIndex >= 0) {
            updatePreviewAndInfo(navItems[selectedIndex].item);
        }
    }

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
            if (v.type === 'header') {
                const { fname, dir } = splitPath(v.data.relativePath);
                return `<div class="file-group" style="height:${v.height}px">` +
                       `<div class="flex items-center gap-2 px-6 py-1 text-[11px] font-bold text-foam uppercase tracking-wider opacity-80">` +
                       `<span>${escHtml(fname)}</span>` +
                       `<span class="opacity-50 font-mono text-[9px] lowercase truncate">${escHtml(dir)}</span>` +
                       `</div></div>`;
            } else if (v.type === 'match') {
                const match = v.data;
                const sel = v.index === selectedIndex ? ' selected' : '';
                const { fname, dir } = splitPath(match.relativePath || '');
                const icon = getFileIcon(fname);

                if (currentMode === 'grep' || currentMode === 'symbols') {
                    const highlight = (currentMode === 'symbols' && !searchInput.value) ? escHtml(match.text) : highlightText(match.text.trimStart(), searchInput.value, grepMode);
                    return `<div class="result-item cursor-pointer flex items-center gap-6 font-mono text-[12px] px-6${sel}" data-index="${v.index}" style="height:${v.height}px">` +
                           `<span class="shrink-0 opacity-40 w-12 text-right">${match.line}</span>` +
                           `<span class="truncate">${highlight}</span>` +
                           `</div>`;
                } else {
                    return `<div class="result-item cursor-pointer flex items-center gap-4 font-mono text-[12px] px-6${sel}" data-index="${v.index}" style="height:${v.height}px">` +
                        `<i class="codicon codicon-${icon} shrink-0 opacity-50" style="font-size:14px"></i>` +
                        `<span class="text-foam truncate">${highlightText(fname, searchInput.value, 'plain')}</span>` +
                        `<span class="opacity-40 text-[11px] truncate">${escHtml(dir)}</span>` +
                        `</div>`;
                }
            } else {
                return `<div style="height:${v.height}px"></div>`;
            }
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
            updatePreviewAndInfo(navItems[selectedIndex].item);
        }
    }

    function scrollToSelected() {
        const item = virtualItems.find(v => v.type === 'match' && v.index === selectedIndex);
        if (!item) return;
        
        const scrollTop = resultsList.scrollTop;
        const viewportHeight = resultsList.clientHeight;
        const topPadding = 4;
        
        const itemTop = item.top;
        const itemBottom = itemTop + item.height;

        if (itemTop < scrollTop) {
            resultsList.scrollTop = itemTop - topPadding;
        } else if (itemBottom > scrollTop + viewportHeight) {
            resultsList.scrollTop = itemBottom - viewportHeight + topPadding;
        }
    }

    function formatSize(bytes) {
        if (!bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const size = parseFloat((bytes / k ** i).toFixed(1));
        return `${size} ${sizes[i]}`;
    }

    function updatePreviewAndInfo(item, stats = null) {
        const { fname, dir } = splitPath(item.relativePath || '');
        const ext = fname.split('.').pop() || 'plain';
        
        let infoHtml = `<div class="flex flex-col gap-1 font-mono text-[12px]">`;
        
        const row = (label, value) => `<div class="flex"><span class="meta-label">${label}:</span><span class="meta-value">${value}</span></div>`;

        infoHtml += row('Size', stats ? formatSize(stats.size) : '-');
        infoHtml += row('Type', ext);
        
        const gitStatus = stats?.gitStatus || 'none';
        const gitColor = { 
            'modified': 'var(--rp-rose)', 
            'added': 'var(--rp-pine)', 
            'untracked': 'var(--rp-iris)', 
            'unmodified': 'var(--rp-subtle)',
            'none': 'inherit' 
        }[gitStatus] || 'inherit';
        infoHtml += `<div class="flex"><span class="meta-label">Git:</span><span class="font-bold" style="color:${gitColor}">${gitStatus}</span></div>`;

        infoHtml += `<div class="mt-4 opacity-30 text-[10px] uppercase font-black tracking-widest">Timings</div>`;
        if (stats) {
            const date = new Date(stats.mtime).toLocaleString();
            infoHtml += row('Modified', date);
        } else {
            infoHtml += row('Modified', '-');
        }
        
        infoHtml += `</div>`;
        infoContent.innerHTML = infoHtml;
        previewLabel.textContent = item.relativePath;
        vscode.postMessage({ command: 'preview', item });
    }

    function renderPreview(data) {
        // Verify this preview still matches the current selection to avoid race conditions
        const currentItem = navItems[selectedIndex]?.item;
        if (!currentItem || 
            currentItem.file !== data.item.file || 
            (currentItem.type === 'grep' && currentItem.line !== data.item.line)) {
            return;
        }

        if (!data.content) {
            previewContent.innerHTML = `<div class="empty-state">Cannot read file</div>`;
            return;
        }
        if (data.stats) {
            updatePreviewAndInfo(currentItem, data.stats);
        }
        const lines = data.content.split('\n');
        let html = `<div class="p-6" style="font-family: inherit; font-size:13px; line-height:1.7; padding-bottom:50vh; color:var(--rp-text)">`;
        for (let i = 0; i < lines.length; i++) {
            const lineNum = data.startLine + i;
            const isTarget = lineNum === data.targetLine;
            html += `<div class="preview-line flex${isTarget ? ' highlight' : ''}" style="white-space:pre">` +
                `<span class="line-num shrink-0 text-right select-none opacity-30 px-5" style="min-width:56px; font-size:11px">${lineNum}</span>` +
                `<span class="flex-1 min-w-0">${isTarget && (currentMode === 'grep' || currentMode === 'symbols') ? highlightText(lines[i], searchInput.value, grepMode) : escHtml(lines[i])}</span>` +
                `</div>`;
        }
        html += '</div>';
        previewContent.innerHTML = html;
        requestAnimationFrame(() => {
            const highlighted = previewContent.querySelector('.preview-line.highlight');
            highlighted?.scrollIntoView({ block: 'center' });
        });
    }

    searchInput.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'n':
            case 'N':
                if (e.altKey) {
                    e.preventDefault();
                    selectResult(selectedIndex + 1);
                }
                break;
            case 'p':
            case 'P':
                if (e.altKey) {
                    e.preventDefault();
                    selectResult(selectedIndex - 1);
                }
                break;
            case 'ArrowDown':
                e.preventDefault();
                if (e.altKey) {
                    if (historyIndex < history.length - 1) {
                        historyIndex++;
                        searchInput.value = history[historyIndex] || '';
                        triggerSearch();
                    }
                } else {
                    selectResult(selectedIndex + 1);
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (e.altKey) {
                    if (historyIndex > 0) {
                        historyIndex--;
                        searchInput.value = history[historyIndex] || '';
                        triggerSearch();
                    } else if (historyIndex === 0) {
                        historyIndex = -1;
                        searchInput.value = '';
                        renderResults([]);
                    }
                } else {
                    selectResult(selectedIndex - 1);
                }
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && navItems[selectedIndex]) {
                    openResult(navItems[selectedIndex].item, e.ctrlKey);
                }
                break;
            case 't':
            case 'T':
                if (e.ctrlKey) {
                    e.preventDefault();
                    if (selectedIndex >= 0 && navItems[selectedIndex]) {
                        openResult(navItems[selectedIndex].item, false, false);
                    }
                }
                break;
            case 'v':
            case 'V':
                if (e.ctrlKey) {
                    e.preventDefault();
                    if (selectedIndex >= 0 && navItems[selectedIndex]) {
                        openResult(navItems[selectedIndex].item, true);
                    }
                }
                break;
            case 'Escape':
                e.preventDefault();
                vscode.postMessage({ command: 'close' });
                break;
            case 'Tab':
                e.preventDefault();
                {
                    const nextIdx = (MODES.indexOf(currentMode) + 1) % MODES.length;
                    setMode(MODES[nextIdx]);
                }
                break;
            case 'r':
            case 'R':
                if (e.altKey) {
                    e.preventDefault();
                    if (currentMode === 'grep') { toggleRegex(); }
                }
                break;
        }
    });

    function openResult(item, sideBySide = false, dispose = true) {
        vscode.postMessage({ command: 'open', item, sideBySide, dispose });
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
        resultsLabel.textContent = labels[mode] || mode;
        searchInput.placeholder = `Search ${labels[mode]}…`;
        btnRegex.style.display = mode === 'grep' ? '' : 'none';
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

    function highlightText(text, query, mode) {
        if (!query) { return escHtml(text); }
        try {
            const pattern = mode === 'regex' ? query : escapeRegex(query);
            const re = new RegExp(pattern, 'gi');
            let result = '';
            let lastIndex = 0;
            for (let match = re.exec(text); match !== null; match = re.exec(text)) {
                result += escHtml(text.slice(lastIndex, match.index));
                result += `<mark class="search-match">${escHtml(match[0])}</mark>`;
                lastIndex = match.index + match[0].length;
                if (match[0].length === 0) { re.lastIndex++; }
            }
            result += escHtml(text.slice(lastIndex));
            return result;
        } catch (_) {
            return escHtml(text);
        }
    }
}());
