import * as vscode from 'vscode';

export const REFRESH_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('refresh'),
    tooltip: 'Refresh results',
};

export const CYCLE_SCOPE_BUTTON: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('sync'),
    tooltip: 'Cycle Search Scope',
};
