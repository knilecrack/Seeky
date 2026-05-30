import { readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { FileFinder, GrepMatch, FileItem } from '@ff-labs/fff-node';
import { log } from './logger';
import { spawnSync } from 'node:child_process';

export interface GrepResult {
    type: 'grep';
    file: string;
    relativePath: string;
    line: number;
    col: number;
    text: string;
    frecencyScore: number;
}

export interface FileResult {
    type: 'file';
    file: string;
    relativePath: string;
    source?: 'git-modified';
    frecencyScore?: number;
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
                frecencyScore: match.totalFrecencyScore ?? 0,
            });
        }

        onDone(cancelled, duration);
    })();

    return () => { cancelled = true; };
}

function getGitModifiedFiles(workspacePath: string): string[] {
    const out = execSync('git status --porcelain', {
        cwd: workspacePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (!out) return [];
    return out
        .split('\n')
        .map(line => {
            const status = line.slice(0, 2);
            const pathPart = line.slice(3).trim();

            // Exclude deleted paths because they cannot be opened in editor preview.
            if (status.includes('D')) {
                return '';
            }

            // Rename entries are represented as: "old/path -> new/path".
            const renamedParts = pathPart.split(' -> ');
            return renamedParts.length > 1
                ? renamedParts[renamedParts.length - 1]?.trim() ?? ''
                : pathPart;
        })
        .filter(path => path.length > 0);
}

export function searchGitModifiedFiles(
    query: string,
    workspacePath: string,
    onResult: (result: FileResult) => void,
    onDone: (cancelled: boolean, duration?: number) => void
): () => void {
    let cancelled = false;

    const start = performance.now();

    try {
        const normalizedQuery = query.trim().toLowerCase();
        const modifiedPaths = getGitModifiedFiles(workspacePath);
        for (const relativePath of modifiedPaths) {
            if (cancelled) {
                break;
            }

            if (normalizedQuery && !relativePath.toLowerCase().includes(normalizedQuery)) {
                continue;
            }

            onResult({
                type: 'file',
                file: join(workspacePath, relativePath),
                relativePath,
                source: 'git-modified',
            });
        }

        onDone(cancelled, performance.now() - start);
    } catch {
        onDone(cancelled, performance.now() - start);
    }

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
            });
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

export function readGitDiffPreview(
    filePath: string,
    workspacePath: string
): { content: string; startLine: number; stats?: { size: number; mtime: number; gitStatus?: string } } {
    let stats: { size: number; mtime: number; gitStatus?: string } | undefined;
    try {
        const fileStats = statSync(filePath);
        stats = {
            size: fileStats.size,
            mtime: fileStats.mtimeMs,
            gitStatus: getGitStatus(filePath, workspacePath),
        };
    } catch {
        stats = undefined;
    }

    try {
        const relativePath = relative(workspacePath, filePath).replace(/\\/g, '/');
        const runDiff = (args: string[]): string => {
            const result = spawnSync('git', args, {
                cwd: workspacePath,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            if (result.error) {
                return '';
            }
            return result.stdout?.trim() ?? '';
        };

        let content = runDiff(['diff', '--no-color', '--', relativePath]);
        if (!content) {
            content = runDiff(['diff', '--no-color', '--cached', '--', relativePath]);
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

    const fallback = readFilePreview(filePath, workspacePath, 1);
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
