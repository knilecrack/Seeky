// @ts-check
(function () {
    'use strict';

    // @ts-ignore
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
    let results = [];
    let navItems = [];
    let virtualItems = [];
    let totalHeight = 0;
    let searchTimeout = 0;
    const history = [];
    let historyIndex = -1;

    const HEADER_HEIGHT = 40;
    const MATCH_HEIGHT = 37;
    const FILE_ITEM_HEIGHT = 73;
    const GROUP_GAP = 24;

    const MODES = ['grep', 'files', 'recent', 'buffers', 'symbols'];

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
        results = items;
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
                       `<div class="flex items-center gap-3 px-3 py-2 opacity-80 text-[12px] font-black text-foam uppercase tracking-widest border-b border-[var(--rp-hl-low)] mb-2">` +
                       `<span>${escHtml(fname)}</span>` +
                       `<span class="opacity-40 font-mono text-[10px] lowercase tracking-normal truncate">${escHtml(dir)}</span>` +
                       `<span class="ml-auto text-iris font-mono text-[10px]">✦${v.data.matches.length}</span>` +
                       `</div></div>`;
            } else if (v.type === 'match') {
                const match = v.data;
                const sel = v.index === selectedIndex ? ' selected' : '';
                if (currentMode === 'grep' || currentMode === 'symbols') {
                    const highlight = (currentMode === 'symbols' && !searchInput.value) ? escHtml(match.text) : highlightText(match.text.trimStart(), searchInput.value, grepMode);
                    const prefix = currentMode === 'symbols' ? `<span class="text-iris opacity-50 mr-2">[${match.kind}]</span>` : '';
                    return `<div class="result-item cursor-pointer pl-10 pr-4 py-2.5 border-l-4 border-transparent transition-all flex gap-4${sel}" data-index="${v.index}" style="height:${v.height}px">` +
                           `<span class="shrink-0 text-[10px] font-mono opacity-25 w-12 text-right">${match.line}:${match.col}</span>` +
                           `<span class="truncate text-[13px] font-mono leading-relaxed" style="color:var(--rp-text)">${prefix}${highlight}</span>` +
                           `</div>`;
                } else {
                    const { fname, dir } = splitPath(match.relativePath || '');
                    return `<div class="result-item cursor-pointer border-b border-[var(--rp-hl-low)] p-5 flex items-center gap-4${sel}" data-index="${v.index}" style="height:${v.height}px">` +
                        `<div class="flex flex-col min-w-0">` +
                        `<span class="font-bold text-foam text-[15px] truncate">${highlightText(fname, searchInput.value, 'plain')}</span>` +
                        `<span class="text-muted text-[11px] truncate opacity-50">${escHtml(dir)}</span>` +
                        `</div>` +
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
        const topPadding = 12;
        
        const itemTop = item.top + topPadding;
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
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function updatePreviewAndInfo(item, stats = null) {
        const { fname, dir } = splitPath(item.relativePath || '');
        let infoHtml = `<div class="flex flex-col gap-4">`;
        infoHtml += `<div class="flex flex-col gap-1.5"><span class="text-[9px] uppercase font-black tracking-widest opacity-30">Path</span><span class="text-foam font-mono text-[12px] truncate">${escHtml(item.relativePath)}</span></div>`;
        
        if (item.type === 'grep' || item.type === 'symbol') {
            infoHtml += `<div class="flex flex-col gap-1.5"><span class="text-[9px] uppercase font-black tracking-widest opacity-30">Location</span><span class="text-iris font-mono text-[12px]">Line ${item.line}, Col ${item.col}</span></div>`;
        }

        const gitColor = { 'modified': 'var(--rp-rose)', 'added': 'var(--rp-pine)', 'untracked': 'var(--rp-iris)', 'none': 'inherit' }[stats?.gitStatus || 'none'];
        const gitText = stats?.gitStatus ? `<span style="color:${gitColor}">${stats.gitStatus.toUpperCase()}</span>` : '-';

        infoHtml += `<div class="grid grid-cols-2 gap-8 mt-2">` +
                    `<div class="flex flex-col gap-1.5"><span class="text-[9px] uppercase font-black tracking-widest opacity-30">Git Status</span><span class="font-mono text-[11px] font-bold">${gitText}</span></div>` +
                    `<div class="flex flex-col gap-1.5"><span class="text-[9px] uppercase font-black tracking-widest opacity-30">Size</span><span class="text-rose font-mono text-[12px]">${stats ? formatSize(stats.size) : '-'}</span></div>` +
                    `</div>`;

        if (stats) {
            const date = new Date(stats.mtime).toLocaleString();
            infoHtml += `<div class="flex flex-col gap-1.5 mt-2"><span class="text-[9px] uppercase font-black tracking-widest opacity-30">Modified</span><span class="text-gold font-mono text-[12px] whitespace-nowrap">${date}</span></div>`;
        }
        
        infoHtml += `</div>`;
        infoContent.innerHTML = infoHtml;
        previewLabel.textContent = `${fname}${item.type === 'grep' || item.type === 'symbol' ? ':' + item.line : ''}`;
        vscode.postMessage({ command: 'preview', item });
    }

    function renderPreview(data) {
        if (!data.content) {
            previewContent.innerHTML = `<div class="empty-state">Cannot read file</div>`;
            return;
        }
        if (data.stats && navItems[selectedIndex]) {
            updatePreviewAndInfo(navItems[selectedIndex].item, data.stats);
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
                const nextIdx = (MODES.indexOf(currentMode) + 1) % MODES.length;
                setMode(MODES[nextIdx]);
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
            let match;
            while ((match = re.exec(text)) !== null) {
                result += escHtml(text.slice(lastIndex, match.index));
                result += `<mark class="search-match" style="background:var(--rp-gold);color:var(--rp-base);border-radius:2px;padding:0 2px;font-weight:600">${escHtml(match[0])}</mark>`;
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
