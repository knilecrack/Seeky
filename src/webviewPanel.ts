import { extname } from 'node:path';
import * as vscode from 'vscode';
import {
    searchGrep,
    searchFiles,
    readFilePreview,
    SearchResult,
} from './searchProvider';

export type SearchMode = 'grep' | 'files';
export type GrepMode = 'plain' | 'regex';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export class ModalSearchPanel {
    private static instance: ModalSearchPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private cancelSearch: (() => void) | undefined;
    private readonly workspacePath: string;
    /** The view column the user was editing in before opening the modal. */
    private readonly originViewColumn: vscode.ViewColumn;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        mode: SearchMode,
        initialQuery: string
    ) {
        this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        // Capture the last focused editor column *before* the panel opens.
        this.originViewColumn =
            vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

        this.panel = vscode.window.createWebviewPanel(
            'seeky',
            'Seeky',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
            }
        );

        this.panel.webview.html = this.getHtmlContent(mode, initialQuery);
        this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
        this.panel.onDidDispose(() => {
            ModalSearchPanel.instance = undefined;
            this.cancelSearch?.();
        });
    }

    static show(context: vscode.ExtensionContext, mode: SearchMode, initialQuery = ''): void {
        if (ModalSearchPanel.instance) {
            ModalSearchPanel.instance.panel.reveal(vscode.ViewColumn.Active);
            if (initialQuery) {
                ModalSearchPanel.instance.panel.webview.postMessage({ command: 'setQuery', query: initialQuery, mode });
            } else {
                ModalSearchPanel.instance.panel.webview.postMessage({ command: 'setMode', mode });
            }
            return;
        }
        ModalSearchPanel.instance = new ModalSearchPanel(context, mode, initialQuery);
    }

    static dispose(): void {
        ModalSearchPanel.instance?.panel.dispose();
    }

    private async handleMessage(msg: { command: string;[key: string]: unknown }): Promise<void> {
        switch (msg.command) {
            case 'search':
                this.runSearch(
                    msg['query'] as string,
                    msg['mode'] as SearchMode,
                    (msg['grepMode'] as GrepMode | undefined) ?? 'plain'
                );
                break;
            case 'preview':
                this.sendPreview(msg['item'] as SearchResult);
                break;
            case 'open':
                await this.openItem(msg['item'] as SearchResult);
                break;
            case 'close':
                this.panel.dispose();
                break;
        }
    }

    private runSearch(query: string, mode: SearchMode, grepMode: GrepMode): void {
        this.cancelSearch?.();
        this.cancelSearch = undefined;

        if (!query.trim() || !this.workspacePath) {
            this.panel.webview.postMessage({ command: 'results', items: [], done: true });
            return;
        }

        const items: SearchResult[] = [];

        const onResult = (item: SearchResult) => {
            items.push(item);
        };

        const onDone = (cancelled: boolean) => {
            this.panel.webview.postMessage({ command: 'results', items, done: true, capped: cancelled });
        };

        if (mode === 'grep') {
            this.cancelSearch = searchGrep(query, this.workspacePath, grepMode, onResult, onDone);
        } else {
            this.cancelSearch = searchFiles(query, this.workspacePath, onResult, onDone);
        }
    }

    private sendPreview(item: SearchResult): void {
        const targetLine = item.type === 'grep' ? item.line : 1;
        const { content, startLine } = readFilePreview(item.file, targetLine);
        const language = extname(item.file).slice(1);

        this.panel.webview.postMessage({
            command: 'preview',
            content,
            targetLine,
            startLine,
            language,
        });
    }

    private async openItem(item: SearchResult): Promise<void> {
        const line = item.type === 'grep' ? item.line - 1 : 0;
        const col = item.type === 'grep' ? item.col - 1 : 0;
        const targetColumn = this.originViewColumn;

        this.panel.dispose();

        try {
            const doc = await vscode.workspace.openTextDocument(item.file);
            await vscode.window.showTextDocument(doc, {
                viewColumn: targetColumn,
                selection: new vscode.Range(line, col, line, col),
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Could not open file: ${item.file}`);
        }
    }

    private getHtmlContent(mode: SearchMode, initialQuery: string): string {
        const nonce = getNonce();
        const webview = this.panel.webview;

        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js')
        );

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.tailwindcss.com;">
    <script nonce="${nonce}">
        window.tailwindConfig = { corePlugins: { preflight: false } };
    </script>
    <script src="https://cdn.tailwindcss.com"></script>
    <script nonce="${nonce}">
        if (typeof tailwind !== 'undefined') tailwind.config = { corePlugins: { preflight: false } };
    </script>
    <link rel="stylesheet" href="${styleUri}">
    <title>Seeky</title>
</head>
<body class="h-screen overflow-hidden" style="background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family,system-ui,sans-serif);font-size:var(--vscode-font-size,13px)">
    <div id="app" data-mode="${mode}" data-initial-query="${escAttr(initialQuery)}" class="flex flex-col h-full overflow-hidden">

        <!-- Header: search input + mode toggle -->
        <div id="header" class="flex items-center gap-2 px-3 py-2 shrink-0 border-b"
             style="background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border-color:var(--vscode-widget-border,var(--vscode-panel-border))">
            <span id="mode-icon" class="shrink-0 select-none text-base leading-none">${mode === 'grep' ? '🔍' : '📁'}</span>
            <input
                type="text"
                id="search-input"
                placeholder="${mode === 'grep' ? 'Live grep…' : 'Find file…'}"
                autocomplete="off"
                spellcheck="false"
                class="flex-1 min-w-0 px-2.5 py-1.5 rounded text-sm outline-none border transition-colors"
                style="background:var(--vscode-input-background);color:var(--vscode-input-foreground);border-color:var(--vscode-input-border,transparent)"
            >
            <div class="flex gap-1 shrink-0">
                <button id="btn-grep"  class="btn-mode px-3 py-1 text-xs rounded border transition-all ${mode === 'grep' ? 'btn-active' : 'btn-inactive'}"
                        style="border-color:var(--vscode-widget-border,var(--vscode-panel-border))">grep</button>
                <button id="btn-regex" class="btn-mode px-3 py-1 text-xs rounded border font-mono transition-all btn-inactive"
                        style="border-color:var(--vscode-widget-border,var(--vscode-panel-border))" title="Toggle regex mode (Alt+R)">.*</button>
                <button id="btn-files" class="btn-mode px-3 py-1 text-xs rounded border transition-all ${mode === 'files' ? 'btn-active' : 'btn-inactive'}"
                        style="border-color:var(--vscode-widget-border,var(--vscode-panel-border))">files</button>
            </div>
        </div>

        <!-- Content: results list + preview -->
        <div id="content" class="flex flex-1 overflow-hidden">
            <div id="results-pane" class="flex-none overflow-y-auto border-r" style="width:38%;min-width:160px;max-width:420px;border-color:var(--vscode-panel-border,var(--vscode-widget-border))">
                <div id="results-list">
                    <div class="py-8 text-center text-xs italic" style="color:var(--vscode-descriptionForeground);opacity:.5">Type to search…</div>
                </div>
            </div>
            <div id="preview-pane" class="flex flex-col flex-1 overflow-hidden min-w-0">
                <div id="preview-header" class="px-3 py-1 text-xs shrink-0 truncate border-b"
                     style="background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border-color:var(--vscode-panel-border,var(--vscode-widget-border));color:var(--vscode-breadcrumb-foreground,var(--vscode-descriptionForeground));min-height:24px"></div>
                <div id="preview-content" class="flex-1 overflow-auto">
                    <div class="py-8 text-center text-xs italic" style="color:var(--vscode-descriptionForeground);opacity:.5">Select a result to preview</div>
                </div>
            </div>
        </div>

        <!-- Footer: keybinding hints -->
        <div id="footer" class="flex items-center gap-4 px-3 py-1.5 text-xs shrink-0 border-t"
             style="background:var(--vscode-editorWidget-background,var(--vscode-editor-background));border-color:var(--vscode-panel-border,var(--vscode-widget-border));color:var(--vscode-descriptionForeground)">
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>Tab</kbd> mode</span>
            <span><kbd>Alt+R</kbd> regex</span>
            <span><kbd>Esc</kbd> close</span>
            <span id="result-count" class="ml-auto"></span>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
