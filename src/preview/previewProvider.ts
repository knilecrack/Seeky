import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { log } from '../logger';

export const SEEKY_PREVIEW_SCHEME = 'seeky-preview';

export class SeekyPreviewProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        try {
            return await fs.readFile(uri.fsPath, 'utf8');
        } catch (error) {
            log.error(`Seeky preview failed to read ${uri.fsPath}`, error);
            return `// Seeky preview: failed to read ${uri.fsPath}\n`;
        }
    }
}

/**
 * Build a virtual URI for the read-only preview of a real file.
 * The path is preserved (and the original extension kept on the last segment)
 * so VS Code infers the correct language for syntax highlighting.
 */
export function toPreviewUri(realPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SEEKY_PREVIEW_SCHEME, path: realPath });
}
