import { existsSync, mkdirSync, createReadStream, promises as fsPromises } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { getSingletonHighlighter, createCssVariablesTheme, bundledLanguages } from 'shiki';
import type { BundledLanguage, BundledTheme } from 'shiki';
import type { ThemeRegistrationAny } from '@shikijs/types';
import { spawnSync, execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import * as readline from 'node:readline';
import { promisify } from 'node:util';
import type { FileFinder, GrepMatch, FileItem } from '@ff-labs/fff-node';
import { log } from './logger';

const execFileAsync = promisify(execFile);

export interface GrepResult {
    type: 'grep';
    file: string;
    relativePath: string;
    line: number;
    col: number;
    text: string;
    frecencyScore: number;
    gitStatus?: string;
}

export interface FileResult {
    type: 'file';
    file: string;
    relativePath: string;
    source?: 'git-modified';
    frecencyScore?: number;
    gitStatus?: string;
}

export interface ISymbolResult {
    type: 'symbol';
    file: string;
    relativePath: string;
    line: number;
    col: number;
    text: string;
    kind: string;
    containerName?: string;
    gitStatus?: string;
}

export type FFSearchResult = GrepResult | FileResult | ISymbolResult;

const MAX_RESULTS = 100;

let finderInstance: FileFinder | null = null;
let finderPromise: Promise<FileFinder | null> | null = null;
let currentBasePath: string | null = null;

async function getOrCreateFinder(basePath: string, storagePath?: string): Promise<FileFinder | null> {
    // Normalize drive letter casing on Windows so Neovim (J:\) and VS Code (j:\) share the same DB namespace.
    const normalizedBasePath = process.platform === 'win32' && /^[a-z]:/i.test(basePath)
        ? basePath.charAt(0).toUpperCase() + basePath.slice(1)
        : basePath;

    if (finderInstance && currentBasePath === normalizedBasePath) {
        return finderInstance;
    }

    if (finderPromise && currentBasePath === normalizedBasePath) {
        return finderPromise;
    }

    if (currentBasePath !== normalizedBasePath) {
        finderInstance?.destroy();
        finderInstance = null;
        finderPromise = null;
    }

    currentBasePath = normalizedBasePath;
    finderPromise = (async () => {
        const { FileFinder: FF } = await import('@ff-labs/fff-node');

        const seekyDir = join(normalizedBasePath, '.vscode', 'seeky');
        const frecencyDbPath = join(seekyDir, 'frecency.db');
        const historyDbPath = join(seekyDir, 'history.db');

        const ensureDbDir = (dbPath?: string) => {
            if (!dbPath) return;
            const dir = dirname(dbPath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
        };

        ensureDbDir(frecencyDbPath);
        const options: {
            basePath: string;
            aiMode: boolean;
            frecencyDbPath?: string;
            historyDbPath?: string;
            disableMmapCache?: boolean;
            logFilePath?: string;
            logLevel?: "trace" | "debug" | "info" | "warn" | "error";
        } = {
            basePath: normalizedBasePath,
            aiMode: false,
            logLevel: 'debug'
        };
        if (storagePath) {
            if (!existsSync(storagePath)) {
                mkdirSync(storagePath, { recursive: true });
            }
            options.logFilePath = join(storagePath, 'fff.log');
        }
        if (frecencyDbPath) options.frecencyDbPath = frecencyDbPath;
        if (historyDbPath) options.historyDbPath = historyDbPath;
        const result = FF.create(options);
        if (!result.ok) {
            log.error('FFF init failed.', result.error);
            return null;
        }
        await result.value.waitForScan(10_000);
        finderInstance = result.value;
        return finderInstance;
    })();

    return finderPromise;
}

export function destroyFff(): void {
    finderInstance?.destroy();
    finderInstance = null;
    finderPromise = null;
    currentBasePath = null;
}

/**
 * Record a user selection so future searches with similar queries rank the
 * chosen file higher. Safe to call when the finder is not yet initialized —
 * the call is dropped silently.
 */
export function trackQuerySelection(query: string, selectedFilePath: string): void {
    if (!finderInstance || !query.trim() || !selectedFilePath) {
        return;
    }
    try {
        finderInstance.trackQuery(query, selectedFilePath);
    } catch (error) {
        log.error('Seeky: trackQuery failed.', error);
    }
}

export function searchGrep(
    query: string,
    workspacePath: string,
    grepMode: 'plain' | 'regex' | 'fuzzy',
    storagePath: string | undefined,
    _currentFile: string | undefined,
    options: { classifyDefinitions?: boolean } | undefined,
    onResult: (result: GrepResult | ISymbolResult) => void,
    onDone: (cancelled: boolean, duration?: number) => void
): () => void {
    let cancelled = false;

    (async () => {
        const finder = await getOrCreateFinder(workspacePath, storagePath);
        if (cancelled || !finder) { onDone(cancelled); return; }

        // Yield to the macrotask queue so VS Code can process pending IPC messages
        // (e.g. new keystrokes) and trigger cancelSearch before we block the event loop.
        await new Promise(r => setTimeout(r, 0));
        if (cancelled) { onDone(cancelled); return; }

        const start = performance.now();
        const result = finder.grep(query, {
            mode: grepMode,
            smartCase: true,
            pageSize: MAX_RESULTS,
            maxMatchesPerFile: 100,
            timeBudgetMs: 150,
            ...(options?.classifyDefinitions !== undefined ? { classifyDefinitions: options.classifyDefinitions } : {}),
        });
        const duration = performance.now() - start;

        if (!result.ok) { onDone(false, duration); return; }

        const items = result.value.items as GrepMatch[];
        if (grepMode === 'fuzzy') {
            items.sort((a, b) => (b.fuzzyScore ?? 0) - (a.fuzzyScore ?? 0));
        }

        let finalItems = items;
        if (options?.classifyDefinitions) {
            finalItems = items.filter(m => m.isDefinition);
        }

        for (const match of finalItems) {
            if (cancelled) { break; }
            const filePath = join(workspacePath, match.relativePath);

            if (options?.classifyDefinitions) {
                // Return as ISymbolResult so it renders with the symbol UI
                onResult({
                    type: 'symbol',
                    file: filePath,
                    relativePath: match.relativePath,
                    line: match.lineNumber,
                    col: match.col + 1,
                    text: match.lineContent.trim(),
                    kind: 'Function', // fff-node doesn't give us the kind, so we default to Function
                    gitStatus: match.gitStatus,
                } as ISymbolResult);
            } else {
                onResult({
                    type: 'grep',
                    file: filePath,
                    relativePath: match.relativePath,
                    line: match.lineNumber,
                    col: match.col + 1,
                    text: match.lineContent,
                    frecencyScore: match.totalFrecencyScore ?? 0,
                    gitStatus: match.gitStatus,
                });
            }
        }

        onDone(cancelled, duration);
    })();

    return () => { cancelled = true; };
}
export function searchGitModifiedFiles(
    query: string,
    workspacePath: string,
    storagePath: string | undefined,
    onResult: (result: FileResult) => void,
    onDone: (cancelled: boolean, duration?: number) => void
): () => void {
    let cancelled = false;

    (async () => {
        const finder = await getOrCreateFinder(workspacePath, storagePath);
        if (cancelled || !finder) { onDone(cancelled); return; }

        // Yield to macrotask queue for IPC cancellation
        await new Promise(r => setTimeout(r, 0));
        if (cancelled) { onDone(cancelled); return; }

        const start = performance.now();

        try {
            const normalizedQuery = query.trim().toLowerCase();
            // Use a moderate pageSize — avoids requesting 100k items at once.
            const result = finder.glob("**", { pageSize: 10000 });
            if (!result.ok) { onDone(false, performance.now() - start); return; }

            let collected = 0;
            for (const item of result.value.items) {
                if (cancelled || collected >= MAX_RESULTS) break;
                if (!item.gitStatus || item.gitStatus === 'clean' || item.gitStatus === 'ignored') continue;
                if (normalizedQuery && !item.relativePath.toLowerCase().includes(normalizedQuery)) continue;

                onResult({
                    type: 'file',
                    file: join(workspacePath, item.relativePath),
                    relativePath: item.relativePath,
                    source: 'git-modified',
                    gitStatus: item.gitStatus,
                    frecencyScore: item.totalFrecencyScore ?? 0,
                });
                collected++;
            }

            onDone(cancelled, performance.now() - start);
        } catch {
            onDone(cancelled, performance.now() - start);
        }
    })();

    return () => {
        cancelled = true;
    };
}

export function searchFiles(
    query: string,
    workspacePath: string,
    storagePath: string | undefined,
    currentFile: string | undefined,
    onResult: (result: FileResult) => void,
    onDone: (cancelled: boolean, duration?: number) => void
): () => void {
    let cancelled = false;

    (async () => {
        const finder = await getOrCreateFinder(workspacePath, storagePath);
        if (cancelled || !finder) { onDone(cancelled); return; }

        // Yield to the macrotask queue so VS Code can process pending IPC messages
        await new Promise(r => setTimeout(r, 0));
        if (cancelled) { onDone(cancelled); return; }

        const start = performance.now();
        const result = finder.fileSearch(query, {
            pageSize: MAX_RESULTS,
            ...(currentFile ? { currentFile } : {})
        });
        const duration = performance.now() - start;

        if (!result.ok) { onDone(false, duration); return; }

        for (const item of result.value.items as FileItem[]) {
            if (cancelled) { break; }
            const filePath = join(workspacePath, item.relativePath);
            onResult({
                type: 'file',
                file: filePath,
                relativePath: item.relativePath,
                frecencyScore: item.totalFrecencyScore ?? 0,
                gitStatus: item.gitStatus,
            });
        }

        onDone(cancelled, duration);
    })();

    return () => { cancelled = true; };
}

let shikiTheme: ThemeRegistrationAny | undefined;
async function highlightLines(code: string, filePath: string): Promise<string> {
    const ext = extname(filePath).slice(1).toLowerCase();
    let lang: BundledLanguage | 'text' = 'text';

    if (ext) {
        if (ext in bundledLanguages) {
            lang = ext as BundledLanguage;
        } else {
            const map: Record<string, BundledLanguage> = {
                'js': 'javascript', 'ts': 'typescript', 'jsx': 'javascript', 'tsx': 'typescript',
                'md': 'markdown', 'rs': 'rust', 'py': 'python', 'go': 'go', 'c': 'c', 'cpp': 'cpp',
                'json': 'json', 'css': 'css', 'html': 'html', 'zig': 'zig'
            };
            if (map[ext]) lang = map[ext];
        }
    }

    if (lang === 'text') {
        return escapeHtml(code);
    }

    try {
        if (!shikiTheme) {
            shikiTheme = createCssVariablesTheme({ name: 'css-variables', variablePrefix: '--shiki-' });
        }

        const highlighter = await getSingletonHighlighter({
            themes: [shikiTheme],
            langs: [lang]
        });

        const tokens = highlighter.codeToTokensBase(code, { lang, theme: 'css-variables' as BundledTheme });

        return tokens.map(line => {
            return line.map(token => {
                if (token.color) {
                    return `<span style="color: ${token.color}">${escapeHtml(token.content)}</span>`;
                }
                return escapeHtml(token.content);
            }).join('');
        }).join('\n');
    } catch {
        return escapeHtml(code);
    }
}

function escapeHtml(str: string) {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return str.replace(/[&<>"']/g, c => map[c] || c);
}

export async function readFilePreview(
    filePath: string,
    targetLine: number,
    gitStatus?: string,
    contextLines = 35
): Promise<{ content: string; startLine: number; stats?: { size: number; mtime: number; gitStatus?: string } }> {

    try {
        const stats = await fsPromises.stat(filePath);
        const startLine = Math.max(1, targetLine - contextLines);
        const endLine = targetLine + contextLines;

        const lines: string[] = [];
        const fileStream = createReadStream(filePath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        let currentLine = 1;
        for await (const line of rl) {
            if (currentLine >= startLine && currentLine <= endLine) {
                lines.push(line);
            }
            if (currentLine > endLine) {
                rl.close();
                fileStream.destroy();
                break;
            }
            currentLine++;
        }

        const content = await highlightLines(lines.join('\n'), filePath);

        return {
            content,
            startLine,
            stats: {
                size: stats.size,
                mtime: stats.mtimeMs,
                ...(gitStatus !== undefined ? { gitStatus } : {})
            }
        };
    } catch {
        return { content: '', startLine: 1 };
    }
}

export async function readGitDiffPreview(
    filePath: string,
    workspacePath: string,
    gitStatus?: string
): Promise<{ content: string; startLine: number; stats?: { size: number; mtime: number; gitStatus?: string } }> {
    let stats: { size: number; mtime: number; gitStatus?: string } | undefined;
    try {
        const fileStats = await fsPromises.stat(filePath);
        stats = {
            size: fileStats.size,
            mtime: fileStats.mtimeMs,
            ...(gitStatus !== undefined ? { gitStatus } : {})
        };
    } catch {
        stats = undefined;
    }

    try {
        const relativePath = relative(workspacePath, filePath).replace(/\\/g, '/');
        const runDiff = async (args: string[]): Promise<string> => {
            try {
                const { stdout } = await execFileAsync('git', args, {
                    cwd: workspacePath,
                    encoding: 'utf-8',
                });
                return stdout.trim();
            } catch {
                return '';
            }
        };

        let content = await runDiff(['diff', '--no-color', '--', relativePath]);
        if (!content) {
            content = await runDiff(['diff', '--no-color', '--cached', '--', relativePath]);
        }

        if (!content && stats?.gitStatus === 'untracked') {
            content = [
                `diff --git a/${relativePath} b/${relativePath}`,
                'new file mode 100644',
                '--- /dev/null',
                `+++ b/${relativePath}`,
                '',
                'Untracked file preview: no git diff hunks are available until the file is staged.',
            ].join('\n');
        }

        if (content) {
            return {
                content,
                startLine: 1,
                ...(stats ? { stats } : {}),
            };
        }
    } catch {
        // Fall through to plain preview fallback.
    }

    const fallback = await readFilePreview(filePath, 1, gitStatus);
    return {
        content: fallback.content,
        startLine: 1,
        ...(fallback.stats ? { stats: fallback.stats } : {}),
    };
}

export function batAvailable(): boolean {
    return platfromLookup('bat');
}


export function platfromLookup(name: string): boolean {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSync(lookup, [name], { stdio: 'ignore' });
    return result.status === 0;
}
