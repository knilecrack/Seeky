import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileFinder, GrepMatch, FileItem } from '@ff-labs/fff-node';

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

export type SearchResult = GrepResult | FileResult;

const MAX_RESULTS = 100;

// Bypass esbuild's CJS transform so the ESM package can be imported at runtime
const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<{ FileFinder: typeof FileFinder }>;

let finderInstance: FileFinder | null = null;
let finderPromise: Promise<FileFinder | null> | null = null;
let currentBasePath: string | null = null;

async function getOrCreateFinder(basePath: string): Promise<FileFinder | null> {
    if (finderInstance && currentBasePath === basePath) {
        return finderInstance;
    }

    if (finderPromise && currentBasePath === basePath) {
        return finderPromise;
    }

    if (currentBasePath !== basePath) {
        finderInstance?.destroy();
        finderInstance = null;
        finderPromise = null;
    }

    currentBasePath = basePath;
    finderPromise = (async () => {
        const { FileFinder: FF } = await dynamicImport('@ff-labs/fff-node');
        const result = FF.create({ basePath, aiMode: false });
        if (!result.ok) {
            console.error('[Seeky] FFF init failed:', result.error);
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
    grepMode: 'plain' | 'regex',
    onResult: (result: GrepResult) => void,
    onDone: (cancelled: boolean) => void
): () => void {
    let cancelled = false;

    (async () => {
        const finder = await getOrCreateFinder(workspacePath);
        if (cancelled || !finder) { onDone(cancelled); return; }

        const result = finder.grep(query, {
            mode: grepMode,
            smartCase: true,
            pageSize: MAX_RESULTS,
        });

        if (!result.ok) { onDone(false); return; }

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

        onDone(cancelled);
    })();

    return () => { cancelled = true; };
}

export function searchFiles(
    query: string,
    workspacePath: string,
    onResult: (result: FileResult) => void,
    onDone: (cancelled: boolean) => void
): () => void {
    let cancelled = false;

    (async () => {
        const finder = await getOrCreateFinder(workspacePath);
        if (cancelled || !finder) { onDone(cancelled); return; }

        const result = finder.fileSearch(query, { pageSize: MAX_RESULTS });

        if (!result.ok) { onDone(false); return; }

        for (const item of result.value.items as FileItem[]) {
            if (cancelled) { break; }
            const filePath = join(workspacePath, item.relativePath);
            onResult({ type: 'file', file: filePath, relativePath: item.relativePath });
        }

        onDone(cancelled);
    })();

    return () => { cancelled = true; };
}

export function readFilePreview(
    filePath: string,
    targetLine: number,
    contextLines = 35
): { content: string; startLine: number } {
    try {
        const raw = readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n');
        const start = Math.max(0, targetLine - contextLines - 1);
        const end = Math.min(lines.length, targetLine + contextLines);
        return { content: lines.slice(start, end).join('\n'), startLine: start + 1 };
    } catch {
        return { content: '', startLine: 1 };
    }
}

