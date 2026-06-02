import * as vscode from 'vscode';

export class PreviewDecorations implements vscode.Disposable {
    private readonly decoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        border: '1px solid var(--vscode-editor-findMatchBorder)',
    });
    private lastEditor: vscode.TextEditor | undefined;

    setHighlight(editor: vscode.TextEditor, ranges: readonly vscode.Range[]): void {
        editor.setDecorations(this.decoration, ranges);
        this.lastEditor = editor;
    }

    clear(): void {
        if (this.lastEditor) {
            this.lastEditor.setDecorations(this.decoration, []);
            this.lastEditor = undefined;
            return;
        }

        const active = vscode.window.activeTextEditor;
        if (active) {
            active.setDecorations(this.decoration, []);
        }
    }

    dispose(): void {
        this.decoration.dispose();
    }
}
