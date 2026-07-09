import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { FileFinder } from '@ff-labs/fff-node';

const DEFAULT_MAX_RESULTS = 100;
const finderInstances = new Map();
const finderPromises = new Map();
const cancelledRequests = new Set();

function normalizeBasePath(basePath) {
    if (process.platform === 'win32' && /^[a-z]:/i.test(basePath)) {
        return `${basePath.charAt(0).toUpperCase()}${basePath.slice(1)}`;
    }

    return basePath;
}

function ensureDbDir(dbPath) {
    if (!dbPath) {
        return;
    }

    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

function resolveDbPaths(storagePath) {
    const isWin = process.platform === 'win32';
    const localAppData = process.env.LOCALAPPDATA;
    const home = process.env.HOME || process.env.USERPROFILE || '';

    if (isWin && localAppData) {
        return {
            frecencyDbPath: join(localAppData, 'nvim-data', 'fff_nvim', 'frecency.db'),
            historyDbPath: join(localAppData, 'nvim-data', 'fff_queries', 'history.db'),
        };
    }

    if (!isWin && home) {
        return {
            frecencyDbPath: join(home, '.cache', 'nvim', 'fff_nvim', 'frecency.db'),
            historyDbPath: join(home, '.local', 'share', 'nvim', 'fff_queries', 'history.db'),
        };
    }

    if (storagePath) {
        return {
            frecencyDbPath: join(storagePath, 'frecency.db'),
            historyDbPath: join(storagePath, 'history.db'),
        };
    }

    return {};
}

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(requestId, message) {
    send({ type: 'error', requestId, message });
}

async function getOrCreateFinder(workspacePath, storagePath) {
    const normalizedBasePath = normalizeBasePath(workspacePath);

    if (finderInstances.has(normalizedBasePath)) {
        return finderInstances.get(normalizedBasePath);
    }

    if (finderPromises.has(normalizedBasePath)) {
        return finderPromises.get(normalizedBasePath);
    }

    const promise = (async () => {
        const { frecencyDbPath, historyDbPath } = resolveDbPaths(storagePath);
        ensureDbDir(frecencyDbPath);
        ensureDbDir(historyDbPath);

        const options = {
            basePath: normalizedBasePath,
            aiMode: false,
            ...(frecencyDbPath ? { frecencyDbPath } : {}),
            ...(historyDbPath ? { historyDbPath } : {}),
        };

        const result = FileFinder.create(options);
        if (!result.ok) {
            throw new Error(result.error);
        }

        await result.value.waitForScan(10_000);
        finderInstances.set(normalizedBasePath, result.value);
        finderPromises.delete(normalizedBasePath);
        return result.value;
    })();

    finderPromises.set(normalizedBasePath, promise);
    return promise;
}

function destroyFinder(workspacePath) {
    const normalizedBasePath = normalizeBasePath(workspacePath);
    finderInstances.get(normalizedBasePath)?.destroy();
    finderInstances.delete(normalizedBasePath);
    finderPromises.delete(normalizedBasePath);
}

function emitFileResults(request, workspacePath, searchResult) {
    const items = searchResult.value.items ?? [];
    let count = 0;

    for (const item of items) {
        if (cancelledRequests.has(request.requestId)) {
            break;
        }

        count += 1;
        send({
            type: 'result',
            requestId: request.requestId,
            item: {
                type: 'file',
                file: join(workspacePath, item.relativePath),
                relativePath: item.relativePath,
                frecencyScore: item.totalFrecencyScore ?? 0,
            },
        });
    }

    return count;
}

function emitGrepResults(request, workspacePath, searchResult) {
    const items = searchResult.value.items ?? [];
    let count = 0;

    for (const match of items) {
        if (cancelledRequests.has(request.requestId)) {
            break;
        }

        count += 1;
        send({
            type: 'result',
            requestId: request.requestId,
            item: {
                type: 'grep',
                file: join(workspacePath, match.relativePath),
                relativePath: match.relativePath,
                line: match.lineNumber,
                col: match.col + 1,
                text: match.lineContent,
                frecencyScore: match.totalFrecencyScore ?? 0,
            },
        });
    }

    return count;
}

async function handleSearch(request) {
    const start = performance.now();

    try {
        const finder = await getOrCreateFinder(request.workspacePath, request.storagePath);
        const maxResults = request.maxResults ?? DEFAULT_MAX_RESULTS;
        let count = 0;

        if (request.mode === 'files') {
            const result = finder.fileSearch(request.query, {
                pageSize: maxResults,
                ...(request.currentFile ? { currentFile: request.currentFile } : {}),
            });

            if (!result.ok) {
                throw new Error(result.error);
            }

            count = emitFileResults(request, request.workspacePath, result);
        } else if (request.mode === 'grep') {
            const result = finder.grep(request.query, {
                mode: request.grepMode ?? 'fuzzy',
                smartCase: true,
                pageSize: maxResults,
                maxMatchesPerFile: 100,
                timeBudgetMs: 30,
            });

            if (!result.ok) {
                throw new Error(result.error);
            }

            count = emitGrepResults(request, request.workspacePath, result);
        } else {
            throw new Error(`Unsupported mode '${request.mode}'.`);
        }

        cancelledRequests.delete(request.requestId);
        send({
            type: 'done',
            requestId: request.requestId,
            count,
            durationMs: performance.now() - start,
        });
    } catch (error) {
        cancelledRequests.delete(request.requestId);
        sendError(request.requestId, error instanceof Error ? error.message : String(error));
    }
}

async function handleMessage(message) {
    switch (message.type) {
        case 'ping':
            send({ type: 'pong', requestId: message.requestId });
            break;
        case 'init':
            try {
                await getOrCreateFinder(message.workspacePath, message.storagePath);
                send({ type: 'ready', requestId: message.requestId });
            } catch (error) {
                sendError(message.requestId, error instanceof Error ? error.message : String(error));
            }
            break;
        case 'dispose':
            destroyFinder(message.workspacePath);
            send({ type: 'disposed', requestId: message.requestId });
            break;
        case 'cancel':
            cancelledRequests.add(message.requestId);
            send({ type: 'cancelled', requestId: message.requestId });
            break;
        case 'search':
            await handleSearch(message);
            break;
        default:
            sendError(message.requestId ?? 'unknown', `Unsupported message type '${message.type}'.`);
            break;
    }
}

const reader = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
});

reader.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) {
        return;
    }

    let message;
    try {
        message = JSON.parse(trimmed);
    } catch (error) {
        sendError('unknown', error instanceof Error ? error.message : 'Invalid JSON.');
        return;
    }

    void handleMessage(message);
});

reader.on('close', () => {
    for (const finder of finderInstances.values()) {
        finder.destroy();
    }
});
