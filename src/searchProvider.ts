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
import * as vscode from 'vscode';
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

function getMaxResults(): number {
    const configured = vscode.workspace.getConfiguration('seeky').get<number>('maxResults', 200);
    return configured > 0 ? configured : 200;
}

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
    gitModifiedCache = undefined;
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

        const maxResults = getMaxResults();
        const start = performance.now();
        const result = finder.grep(query, {
            mode: grepMode,
            smartCase: true,
            pageSize: maxResults,
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
/**
 * Returns the glob tokens when the query consists solely of file-glob tokens
 * (e.g. "*.cs" or "*.cs src/**"), otherwise null. Used to list matching files
 * instead of running a content grep that would silently return nothing.
 */
export function parseGlobOnlyQuery(query: string): string[] | null {
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return null;
    }
    return tokens.every(token => /[*?[\]]/.test(token)) ? tokens : null;
}

export function searchGlobFiles(
    patterns: string[],
    workspacePath: string,
    storagePath: string | undefined,
    onResult: (result: FileResult) => void,
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
        const seen = new Set<string>();
        let collected = 0;
        const maxResults = getMaxResults();

        for (const pattern of patterns) {
            const result = finder.glob(pattern, { pageSize: maxResults });
            if (!result.ok) { continue; }

            for (const item of result.value.items) {
                if (cancelled || collected >= maxResults) { break; }
                if (seen.has(item.relativePath)) { continue; }
                seen.add(item.relativePath);
                onResult({
                    type: 'file',
                    file: join(workspacePath, item.relativePath),
                    relativePath: item.relativePath,
                    frecencyScore: item.totalFrecencyScore ?? 0,
                    gitStatus: item.gitStatus,
                });
                collected++;
            }
            if (cancelled || collected >= maxResults) { break; }
        }

        onDone(cancelled, performance.now() - start);
    })();

    return () => { cancelled = true; };
}

interface GitModifiedEntry {
    readonly relativePath: string;
    readonly gitStatus: string;
}

const GIT_MODIFIED_CACHE_TTL_MS = 5000;
let gitModifiedCache: { workspacePath: string; entries: GitModifiedEntry[]; timestamp: number } | undefined;

function parseGitStatusCode(x: string, y: string): string {
    if (x === '?' || y === '?') { return 'untracked'; }
    if (x === 'A' || y === 'A') { return 'added'; }
    return 'modified';
}

/**
 * Modified files via `git status --porcelain` — async (never blocks the
 * extension host) and enumerates only changed files, so it stays correct on
 * repos far larger than fff's glob page size.
 */
async function listGitModifiedFiles(workspacePath: string): Promise<GitModifiedEntry[]> {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
        cwd: workspacePath,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
    });

    const fields = stdout.split('\0');
    const entries: GitModifiedEntry[] = [];
    for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        if (!field || field.length < 4) { continue; }
        const x = field.charAt(0);
        const y = field.charAt(1);
        const relativePath = field.slice(3);
        // Never list Seeky's own runtime databases.
        if (relativePath.startsWith('.vscode/seeky/')) { continue; }
        entries.push({ relativePath, gitStatus: parseGitStatusCode(x, y) });
        // Renames/copies carry the source path as a second NUL-separated field.
        if (x === 'R' || x === 'C') { i++; }
    }
    return entries;
}

/** Pre-git fallback: enumerate the index via fff and filter by git status. */
async function listGitModifiedFilesViaFff(finder: FileFinder): Promise<GitModifiedEntry[]> {
    const result = finder.glob("**", { pageSize: 10000 });
    if (!result.ok) { return []; }
    const entries: GitModifiedEntry[] = [];
    for (const item of result.value.items) {
        if (!item.gitStatus || item.gitStatus === 'clean' || item.gitStatus === 'ignored') { continue; }
        if (item.relativePath.startsWith('.vscode/seeky/')) { continue; }
        entries.push({ relativePath: item.relativePath, gitStatus: item.gitStatus });
    }
    return entries;
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
            // Refresh the modified-file list at most once per TTL; per-keystroke
            // searches filter the cached list in memory instead of re-enumerating
            // the whole workspace on every keypress.
            const now = Date.now();
            if (!gitModifiedCache
                || gitModifiedCache.workspacePath !== workspacePath
                || now - gitModifiedCache.timestamp > GIT_MODIFIED_CACHE_TTL_MS) {
                let entries: GitModifiedEntry[];
                try {
                    entries = await listGitModifiedFiles(workspacePath);
                } catch {
                    // No git binary / not a repository — fall back to the fff index.
                    entries = await listGitModifiedFilesViaFff(finder);
                }
                gitModifiedCache = { workspacePath, entries, timestamp: Date.now() };
            }
            if (cancelled) { onDone(cancelled); return; }

            const normalizedQuery = query.trim().toLowerCase();
            const maxResults = getMaxResults();
            let collected = 0;
            for (const entry of gitModifiedCache.entries) {
                if (cancelled || collected >= maxResults) break;
                if (normalizedQuery && !entry.relativePath.toLowerCase().includes(normalizedQuery)) continue;

                onResult({
                    type: 'file',
                    file: join(workspacePath, entry.relativePath),
                    relativePath: entry.relativePath,
                    source: 'git-modified',
                    gitStatus: entry.gitStatus,
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
            pageSize: getMaxResults(),
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

const BINARY_SNIFF_BYTES = 8192;
const MAX_PREVIEW_LINE_LENGTH = 2000;

/**
 * Standard binary heuristic: a NUL byte in the first chunk of the file.
 * Fails safe (treated as text) when the file cannot be opened.
 */
async function isBinaryFile(filePath: string, fileSize: number): Promise<boolean> {
    if (fileSize === 0) {
        return false;
    }
    let handle: fsPromises.FileHandle | undefined;
    try {
        handle = await fsPromises.open(filePath, 'r');
        const buffer = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, fileSize));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).includes(0);
    } catch {
        return false;
    } finally {
        await handle?.close();
    }
}

export async function readFilePreview(
    filePath: string,
    targetLine: number,
    gitStatus?: string,
    contextLines = 35
): Promise<{ content: string; startLine: number; binary?: boolean; stats?: { size: number; mtime: number; gitStatus?: string } }> {

    try {
        const stats = await fsPromises.stat(filePath);

        // Binary sniff: NUL byte in the first chunk. Reading a binary file
        // line-by-line and feeding it to Shiki can stall the extension host.
        if (await isBinaryFile(filePath, stats.size)) {
            return {
                content: '',
                startLine: 1,
                binary: true,
                stats: {
                    size: stats.size,
                    mtime: stats.mtimeMs,
                    ...(gitStatus !== undefined ? { gitStatus } : {})
                }
            };
        }

        const startLine = Math.max(1, targetLine - contextLines);
        const endLine = targetLine + contextLines;

        const lines: string[] = [];
        const fileStream = createReadStream(filePath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        let currentLine = 1;
        for await (const line of rl) {
            if (currentLine >= startLine && currentLine <= endLine) {
                // Truncate pathological lines (minified bundles) — highlighting a
                // multi-MB single line can stall the extension host.
                lines.push(line.length > MAX_PREVIEW_LINE_LENGTH
                    ? `${line.slice(0, MAX_PREVIEW_LINE_LENGTH)} …`
                    : line);
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
): Promise<{ content: string; startLine: number; binary?: boolean; stats?: { size: number; mtime: number; gitStatus?: string } }> {
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
        ...(fallback.binary ? { binary: true } : {}),
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
