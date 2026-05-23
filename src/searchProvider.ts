import { readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { FileFinder, GrepMatch, FileItem } from '@ff-labs/fff-node';
import { log } from './logger';

export interface GrepResult {
    type: 'grep';
    file: string;
    relativePath: string;
    line: number;
    col: number;
    text: string;
}

export interface FileResult {
    type: 'file';
    file: string;
    relativePath: string;
}

export interface SymbolResult {
    type: 'symbol';
    file: string;
    relativePath: string;
    line: number;
    col: number;
    text: string;
    kind: string;
    containerName?: string;
}

export type SearchResult = GrepResult | FileResult | SymbolResult;

const MAX_RESULTS = 100;

// Bypass esbuild's CJS transform so the ESM package can be imported at runtime
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<{ FileFinder: typeof FileFinder }>;

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
        const { pathToFileURL } = await import('node:url');
        const modulePath = join(__dirname, '../node_modules/@ff-labs/fff-node/dist/src/index.js');
        const moduleUrl = pathToFileURL(modulePath).toString();
        const { FileFinder: FF } = await dynamicImport(moduleUrl);

        let frecencyDbPath: string | undefined;
        let historyDbPath: string | undefined;

        // Sync with Neovim fff.nvim databases
        const isWin = process.platform === 'win32';
        const localAppData = process.env['LOCALAPPDATA'];
        const home = process.env['HOME'] || process.env['USERPROFILE'] || '';

        if (isWin && localAppData) {
            frecencyDbPath = join(localAppData, 'nvim-data', 'fff_nvim', 'frecency.db');
            historyDbPath = join(localAppData, 'nvim-data', 'fff_queries', 'history.db');
        } else if (!isWin && home) {
            frecencyDbPath = join(home, '.cache', 'nvim', 'fff_nvim', 'frecency.db');
            historyDbPath = join(home, '.local', 'share', 'nvim', 'fff_queries', 'history.db');
        } else if (storagePath) {
            // Fallback to extension storage
            frecencyDbPath = join(storagePath, 'frecency.db');
            historyDbPath = join(storagePath, 'history.db');
        }

        const ensureDbDir = (dbPath?: string) => {
            if (!dbPath) return;
            const dir = dirname(dbPath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
        };

        ensureDbDir(frecencyDbPath);
        const options: { basePath: string; aiMode: boolean; frecencyDbPath?: string; historyDbPath?: string } = { basePath: normalizedBasePath, aiMode: false };
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

export function searchGrep(
    query: string,
    workspacePath: string,
    grepMode: 'plain' | 'regex' | 'fuzzy',
    storagePath: string | undefined,
    _currentFile: string | undefined,
    onResult: (result: GrepResult) => void,
    onDone: (cancelled: boolean, duration?: number) => void
): () => void {
    let cancelled = false;

    (async () => {
        const finder = await getOrCreateFinder(workspacePath, storagePath);
        if (cancelled || !finder) { onDone(cancelled); return; }

        const start = performance.now();
        const result = finder.grep(query, {
            mode: grepMode,
            smartCase: true,
            pageSize: MAX_RESULTS,
            maxMatchesPerFile: 100,
            timeBudgetMs: 30,
        });
        const duration = performance.now() - start;

        if (!result.ok) { onDone(false, duration); return; }

        for (const match of result.value.items as GrepMatch[]) {
            if (cancelled) { break; }
            const filePath = join(workspacePath, match.relativePath);
            onResult({
                type: 'grep',
                file: filePath,
                relativePath: match.relativePath,
                line: match.lineNumber,
                col: match.col + 1,
                text: match.lineContent,
            });
        }

        onDone(cancelled, duration);
    })();

    return () => { cancelled = true; };
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
            onResult({ type: 'file', file: filePath, relativePath: item.relativePath });
        }

        onDone(cancelled, duration);
    })();

    return () => { cancelled = true; };
}

export function getGitStatus(filePath: string, workspacePath: string): string {
    try {
        const output = execSync(`git status --porcelain "${filePath}"`, {
            cwd: workspacePath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        if (!output) return 'unmodified';
        const status = output.slice(0, 2).trim();
        if (status === 'M') return 'modified';
        if (status === 'A') return 'added';
        if (status === '??') return 'untracked';
        return 'modified';
    } catch {
        return 'none';
    }
}

export function readFilePreview(
    filePath: string,
    workspacePath: string,
    targetLine: number,
    contextLines = 35
): { content: string; startLine: number; stats?: { size: number; mtime: number; gitStatus?: string } } {
    try {
        const stats = statSync(filePath);
        const gitStatus = getGitStatus(filePath, workspacePath);
        const raw = readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n');
        const start = Math.max(0, targetLine - contextLines - 1);
        const end = Math.min(lines.length, targetLine + contextLines);
        return {
            content: lines.slice(start, end).join('\n'),
            startLine: start + 1,
            stats: { size: stats.size, mtime: stats.mtimeMs, gitStatus }
        };
    } catch {
        return { content: '', startLine: 1 };
    }
}

