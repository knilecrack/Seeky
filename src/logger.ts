import * as vscode from 'vscode';


type LogLevel = 'info' | 'warn' | 'error';

class SeekyLogger {
    private readonly channel = vscode.window.createOutputChannel('Seeky');

    private write(level: LogLevel, message: string): void {
        const timestamp = new Date().toISOString();
        this.channel.appendLine(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    }

    info(message: string): void {
        this.write('info', message);
    }

    warn(message: string): void {
        this.write('warn', message);
    }

    error(message: string, error?: unknown): void {
        const details = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : error ? String(error) : '';
        this.write('error', details ? `${message}\n${details}` : message);
    }

    dispose(): void {
        this.channel.dispose();
    }
}

export const log = new SeekyLogger();