/**
 * CopilotWatcher - Monitors GitHub Copilot activity in VS Code.
 *
 * Detection strategies:
 * 1. Terminal shell executions (agent running tools) → busy
 * 2. File changes from agent (programmatic edits) → busy
 * 3. User editing files manually → running
 * 4. Inline completion acceptance → running
 * 5. Copilot output channel activity → busy
 * 6. Idle timeout after inactivity → idle
 *
 * The key distinction: agent activity = busy (yellow), user activity = running (green).
 */

import * as vscode from 'vscode';
import { DeviceClient } from './deviceClient';
import { CopilotActivity, mapCopilotToAgent } from './stateMapper';

export class CopilotWatcher implements vscode.Disposable {
    private _client: DeviceClient;
    private _outputChannel: vscode.OutputChannel;
    private _disposables: vscode.Disposable[] = [];
    private _idleTimer: ReturnType<typeof setTimeout> | null = null;
    private _idleTimeout: number = 5000;
    private _running: boolean = false;
    private _lastActivity: CopilotActivity | null = null;
    private _enabled: boolean = true;
    private _lastUserKeystroke: number = 0;

    constructor(client: DeviceClient, outputChannel: vscode.OutputChannel) {
        this._client = client;
        this._outputChannel = outputChannel;
        this.reloadConfig();
    }

    reloadConfig() {
        const config = vscode.workspace.getConfiguration('agentAura');
        this._idleTimeout = config.get<number>('idleTimeout') || 5000;
        this._enabled = config.get<boolean>('enabled') !== false;
    }

    start() {
        if (this._running) { return; }
        if (!this._enabled) { return; }
        this._running = true;

        // 1. Terminal shell executions → busy (agent running tools)
        try {
            if (vscode.window.onDidStartTerminalShellExecution) {
                this._disposables.push(
                    vscode.window.onDidStartTerminalShellExecution(() => {
                        this._onActivity('chat-response');
                    })
                );
            }
            if (vscode.window.onDidEndTerminalShellExecution) {
                this._disposables.push(
                    vscode.window.onDidEndTerminalShellExecution(() => {
                        // Tool finished, reset idle timer but don't change state immediately
                        this._resetIdleTimer();
                    })
                );
            }
        } catch {
            // Terminal shell execution API may not be available
        }

        // 2. File changes - distinguish user edits from agent edits
        this._disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.contentChanges.length === 0) { return; }
                const scheme = e.document.uri.scheme;
                const uri = e.document.uri.toString();

                if (scheme === 'file' || scheme === 'untitled') {
                    // Heuristic: if user was typing recently (< 2s), it's user editing
                    // Otherwise it's likely a programmatic/agent edit
                    const timeSinceKeystroke = Date.now() - this._lastUserKeystroke;
                    if (timeSinceKeystroke < 2000) {
                        this._onActivity('editing');
                    } else {
                        this._onActivity('chat-response');
                    }
                } else if (scheme === 'output') {
                    // Detect Copilot output channel activity (response streaming)
                    if (uri.includes('github.copilot')) {
                        this._onActivity('chat-response');
                    }
                }
            })
        );

        // 3. Track user keystrokes via selection changes (typing indicator)
        this._disposables.push(
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (e.kind === vscode.TextEditorSelectionChangeKind.Keyboard) {
                    this._lastUserKeystroke = Date.now();
                    this._onActivity('editing');
                } else if (e.kind === vscode.TextEditorSelectionChangeKind.Command) {
                    // Command-driven selection = likely inline completion acceptance
                    this._onActivity('inline-accepted');
                }
            })
        );

        // 4. File creation/deletion (agent creating new files)
        this._disposables.push(
            vscode.workspace.onDidCreateFiles(() => {
                this._onActivity('chat-response');
            })
        );

        // 5. Monitor terminal opens (agent spawning tools)
        this._disposables.push(
            vscode.window.onDidOpenTerminal(() => {
                this._onActivity('chat-response');
            })
        );

        // 6. Diagnostics → error state (only when idle)
        this._disposables.push(
            vscode.languages.onDidChangeDiagnostics(e => {
                for (const uri of e.uris) {
                    const diags = vscode.languages.getDiagnostics(uri);
                    const hasErrors = diags.some(d => d.severity === vscode.DiagnosticSeverity.Error);
                    if (hasErrors && this._lastActivity === 'idle') {
                        this._onActivity('error');
                    }
                }
            })
        );

        // 7. Window focus lost → idle
        this._disposables.push(
            vscode.window.onDidChangeWindowState(state => {
                if (!state.focused) {
                    this._onActivity('idle');
                }
            })
        );

        // Start idle timer
        this._resetIdleTimer();
        this._outputChannel.appendLine('[AgentAura] Watcher started');
    }

    stop() {
        this._running = false;
        this._clearIdleTimer();
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables = [];
        this._outputChannel.appendLine('[AgentAura] Watcher stopped');
    }

    /**
     * Manually signal an activity from external sources (e.g., chat participant).
     */
    signalActivity(activity: CopilotActivity) {
        this._onActivity(activity);
    }

    dispose() {
        this.stop();
    }

    // ─── Private ─────────────────────────────────────────────────────

    private _onActivity(activity: CopilotActivity) {
        if (!this._running || !this._enabled) { return; }

        this._lastActivity = activity;
        const agentState = mapCopilotToAgent(activity);
        this._client.sendAgentState(agentState);
        this._resetIdleTimer();
    }

    private _resetIdleTimer() {
        this._clearIdleTimer();
        this._idleTimer = setTimeout(() => {
            if (this._running) {
                this._lastActivity = 'idle';
                const agentState = mapCopilotToAgent('idle');
                this._client.sendAgentState(agentState);
            }
        }, this._idleTimeout);
    }

    private _clearIdleTimer() {
        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
    }
}
