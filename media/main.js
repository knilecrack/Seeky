// @ts-check
(function () {
    'use strict';

    // @ts-ignore
    const vscode = acquireVsCodeApi();

    // ── DOM refs ──────────────────────────────────────────────────────────────
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const searchInput = /** @type {HTMLInputElement} */ (document.getElementById('search-input'));
    const resultsList = /** @type {HTMLElement} */ (document.getElementById('results-list'));
    const previewHeader = /** @type {HTMLElement} */ (document.getElementById('preview-header'));
    const previewContent = /** @type {HTMLElement} */ (document.getElementById('preview-content'));
    const btnGrep = /** @type {HTMLButtonElement} */ (document.getElementById('btn-grep'));
    const btnRegex = /** @type {HTMLButtonElement} */ (document.getElementById('btn-regex'));
    const btnFiles = /** @type {HTMLButtonElement} */ (document.getElementById('btn-files'));
    const modeIcon = /** @type {HTMLElement} */ (document.getElementById('mode-icon'));
    const resultCount = /** @type {HTMLElement} */ (document.getElementById('result-count'));

    // ── State ─────────────────────────────────────────────────────────────────
    let currentMode = app.dataset.mode || 'grep';
    /** @type {'plain' | 'regex'} */
    let grepMode = 'plain';
    let selectedIndex = -1;
    /** @type {Array<Object>} */
    let results = [];
    let searchTimeout = 0;

    // ── Initial focus + pre-fill ──────────────────────────────────────────────
    searchInput.focus();
    const initialQuery = app.dataset.initialQuery || '';
    if (initialQuery) {
        searchInput.value = initialQuery;
        triggerSearch();
    }
    syncRegexButton();

    // ── Mode toggle ───────────────────────────────────────────────────────────
    btnGrep.addEventListener('click', () => setMode('grep'));
    btnFiles.addEventListener('click', () => setMode('files'));
    btnRegex.addEventListener('click', () => toggleRegex());

    function setMode(/** @type {string} */ mode) {
        currentMode = mode;
        btnGrep.className = btnGrep.className.replace(/btn-(active|inactive)/g, '') + (mode === 'grep' ? ' btn-active' : ' btn-inactive');
        btnFiles.className = btnFiles.className.replace(/btn-(active|inactive)/g, '') + (mode === 'files' ? ' btn-active' : ' btn-inactive');
        modeIcon.textContent = mode === 'grep' ? '🔍' : '📁';
        searchInput.placeholder = mode === 'grep' ? 'Live grep…' : 'Find file…';
        // Regex only applies to grep — hide button visual when in files mode
        btnRegex.style.display = mode === 'grep' ? '' : 'none';
        triggerSearch();
    }

    function toggleRegex() {
        grepMode = grepMode === 'plain' ? 'regex' : 'plain';
        syncRegexButton();
        triggerSearch();
    }

    function syncRegexButton() {
        btnRegex.className = btnRegex.className.replace(/btn-(active|inactive)/g, '') + (grepMode === 'regex' ? ' btn-active' : ' btn-inactive');
        btnRegex.style.display = currentMode === 'grep' ? '' : 'none';
    }

    // ── Search input ─────────────────────────────────────────────────────────
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(triggerSearch, 150);
    });

    function triggerSearch() {
        const query = searchInput.value;
        if (!query.trim()) {
            renderResults([]);
            return;
        }
        resultCount.textContent = 'Searching…';
        vscode.postMessage({ command: 'search', query, mode: currentMode, grepMode });
    }

    // ── Keyboard navigation ──────────────────────────────────────────────────
    searchInput.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
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
                if (selectedIndex >= 0 && results[selectedIndex]) {
                    openResult(results[selectedIndex]);
                }
                break;
            case 'Escape':
                e.preventDefault();
                vscode.postMessage({ command: 'close' });
                break;
            case 'Tab':
                e.preventDefault();
                setMode(currentMode === 'grep' ? 'files' : 'grep');
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

    function selectResult(/** @type {number} */ index) {
        if (results.length === 0) { return; }
        selectedIndex = Math.max(0, Math.min(results.length - 1, index));

        document.querySelectorAll('.result-item').forEach((el, i) => {
            el.classList.toggle('selected', i === selectedIndex);
        });

        const selectedEl = resultsList.querySelector('.result-item.selected');
        selectedEl?.scrollIntoView({ block: 'nearest' });

        if (results[selectedIndex]) {
            vscode.postMessage({ command: 'preview', item: results[selectedIndex] });
        }
    }

    function openResult(/** @type {Object} */ item) {
        vscode.postMessage({ command: 'open', item });
    }

    // ── Render results ────────────────────────────────────────────────────────
    function renderResults(/** @type {Array<Object>} */ items, /** @type {boolean} */ capped = false) {
        results = items;
        selectedIndex = items.length > 0 ? 0 : -1;

        if (items.length === 0) {
            resultCount.textContent = '';
            resultsList.innerHTML = '<div class="py-8 text-center text-xs italic" style="color:var(--vscode-descriptionForeground);opacity:.5">No results</div>';
            previewHeader.textContent = '';
            previewContent.innerHTML = '<div class="py-8 text-center text-xs italic" style="color:var(--vscode-descriptionForeground);opacity:.5">No results to preview</div>';
            return;
        }

        const cappedNote = capped ? ` (capped at ${items.length})` : '';
        resultCount.textContent = `${items.length} result${items.length !== 1 ? 's' : ''}${cappedNote}`;

        resultsList.innerHTML = items.map((item, i) => {
            const sel = i === 0 ? ' selected' : '';
            const baseClass = `result-item flex flex-col gap-0.5 px-2.5 py-1.5 cursor-pointer border-l-2 border-b border-l-transparent text-xs`;
            const borderB = `style="border-bottom-color:var(--vscode-panel-border,transparent)"`;
            if (item.type === 'grep') {
                return `<div class="${baseClass}${sel}" data-index="${i}" ${borderB}>` +
                    `<div class="flex items-baseline gap-1 min-w-0">` +
                    `<span class="font-medium truncate" style="color:var(--vscode-textLink-foreground)">${escHtml(item.relativePath)}</span>` +
                    `<span class="shrink-0 text-[10px]" style="color:var(--vscode-descriptionForeground)">:${item.line}:${item.col}</span>` +
                    `</div>` +
                    `<span class="truncate font-mono opacity-75" style="font-size:11px">${escHtml(item.text.trimStart())}</span>` +
                    `</div>`;
            } else {
                return `<div class="${baseClass}${sel}" data-index="${i}" ${borderB}>` +
                    `<div class="flex items-center gap-1.5 min-w-0">` +
                    `<span>📄</span>` +
                    `<span class="truncate" style="color:var(--vscode-textLink-foreground)">${escHtml(item.relativePath)}</span>` +
                    `</div>` +
                    `</div>`;
            }
        }).join('');

        // Click / double-click handlers
        document.querySelectorAll('.result-item').forEach((el) => {
            el.addEventListener('click', () => {
                // @ts-ignore
                selectResult(parseInt(el.dataset.index, 10));
            });
            el.addEventListener('dblclick', () => {
                // @ts-ignore
                const idx = parseInt(el.dataset.index, 10);
                selectResult(idx);
                if (results[idx]) { openResult(results[idx]); }
            });
        });

        // Auto-preview first result
        if (items.length > 0) {
            vscode.postMessage({ command: 'preview', item: items[0] });
        }
    }

    // ── Render preview ────────────────────────────────────────────────────────
    function renderPreview(/** @type {{content: string, targetLine: number, startLine: number, language: string}} */ data) {
        if (!data.content) {
            previewHeader.textContent = '';
            previewContent.innerHTML = '<div class="py-8 text-center text-xs italic" style="color:var(--vscode-descriptionForeground);opacity:.5">Cannot read file</div>';
            return;
        }

        // Show the file path as the preview header
        const item = results[selectedIndex];
        if (item) {
            previewHeader.textContent = item.relativePath || '';
        }

        const lines = data.content.split('\n');
        let html = '<div class="font-mono text-xs leading-relaxed" style="font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px)">';
        for (let i = 0; i < lines.length; i++) {
            const lineNum = data.startLine + i;
            const isTarget = lineNum === data.targetLine;
            html += `<div class="preview-line flex${isTarget ? ' highlight' : ''}" style="padding:0 6px 0 0;white-space:pre${isTarget ? ';outline:1px solid var(--vscode-editor-findMatchHighlightBorder,transparent)' : ''}">` +
                `<span class="line-num shrink-0 text-right select-none opacity-60" style="min-width:44px;padding:0 12px 0 6px;color:var(--vscode-editorLineNumber-foreground)">${lineNum}</span>` +
                `<span class="flex-1 min-w-0" style="color:var(--vscode-editor-foreground)">${escHtml(lines[i])}</span>` +
                `</div>`;
        }
        html += '</div>';
        previewContent.innerHTML = html;

        // Scroll highlighted line into center
        const highlighted = previewContent.querySelector('.preview-line.highlight');
        highlighted?.scrollIntoView({ block: 'center' });
    }

    // ── Messages from extension ───────────────────────────────────────────────
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.command) {
            case 'results':
                renderResults(msg.items, msg.capped);
                break;
            case 'preview':
                renderPreview(msg);
                break;
            case 'setMode':
                setMode(msg.mode);
                searchInput.value = '';
                searchInput.focus();
                renderResults([]);
                break;
            case 'setQuery':
                if (msg.mode) { setMode(msg.mode); }
                searchInput.value = msg.query || '';
                searchInput.focus();
                triggerSearch();
                break;
        }
    });

    // ── Helpers ───────────────────────────────────────────────────────────────
    function escHtml(/** @type {string} */ str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
}());
