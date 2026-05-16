import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join, relative } from 'node:path';
import * as vscode from 'vscode';

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

export function getRgBinary(): string {
    const ext = platform() === 'win32' ? '.exe' : '';
    const rgName = `rg${ext}`;

    const candidates = [
        join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', rgName),
        join(vscode.env.appRoot, 'node_modules', 'vscode-ripgrep', 'bin', rgName),
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return 'rg';
}

export function searchGrep(
    query: string,
    workspacePath: string,
    onResult: (result: GrepResult) => void,
    onDone: (cancelled: boolean) => void
): () => void {
    const rg = getRgBinary();
    const args = [
        '--json',
        '--smart-case',
        '--hidden',
        '--follow',
        '--',
        query,
        workspacePath,
    ];

    const proc = spawn(rg, args);
    let cancelled = false;
    let count = 0;
    let buffer = '';

    proc.stdout.on('data', (data: Buffer) => {
        if (cancelled) { return; }

        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            if (!line.trim() || cancelled) { continue; }
            try {
                const msg = JSON.parse(line);
                if (msg.type === 'match') {
                    const filePath: string = msg.data.path.text;
                    const lineNumber: number = msg.data.line_number;
                    const col: number = (msg.data.submatches[0]?.start ?? 0);
                    const text: string = (msg.data.lines.text as string).replace(/\n$/, '');

                    onResult({
                        type: 'grep',
                        file: filePath,
                        relativePath: relative(workspacePath, filePath),
                        line: lineNumber,
                        col: col + 1,
                        text,
                    });

                    count++;
                    if (count >= MAX_RESULTS) {
                        cancelled = true;
                        proc.kill();
                        return;
                    }
                }
            } catch { /* skip malformed JSON lines */ }
        }
    });

    proc.on('close', () => onDone(cancelled));
    proc.on('error', () => onDone(cancelled));

    return () => {
        cancelled = true;
        proc.kill();
    };
}

export function searchFiles(
    query: string,
    workspacePath: string,
    onResult: (result: FileResult) => void,
    onDone: (cancelled: boolean) => void
): () => void {
    const rg = getRgBinary();
    const args = ['--files', '--hidden', '--follow', workspacePath];

    const proc = spawn(rg, args);
    let cancelled = false;
    let count = 0;
    let buffer = '';
    const lowerQuery = query.toLowerCase();

    proc.stdout.on('data', (data: Buffer) => {
        if (cancelled) { return; }

        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            const filePath = line.trim();
            if (!filePath || cancelled) { continue; }

            const relativePath = relative(workspacePath, filePath);
            if (!query || relativePath.toLowerCase().includes(lowerQuery)) {
                onResult({ type: 'file', file: filePath, relativePath });
                count++;
                if (count >= MAX_RESULTS) {
                    cancelled = true;
                    proc.kill();
                    return;
                }
            }
        }
    });

    proc.on('close', () => onDone(cancelled));
    proc.on('error', () => onDone(cancelled));

    return () => {
        cancelled = true;
        proc.kill();
    };
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
