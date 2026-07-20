/**
 * TranscriptWatcher - Monitors Copilot Chat transcript log files for real-time
 * lifecycle events (thinking, running tools, waiting for approval, completion).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DeviceClient } from './deviceClient';
import { AgentState } from './stateMapper';

interface ToolRequest {
    toolCallId?: string;
    name?: string;
    type?: string;
    arguments?: unknown;
}

interface TranscriptEvent {
    type: string;
    data?: {
        toolCallId?: string;
        toolName?: string;
        toolRequests?: ToolRequest[];
        content?: string;
        reasoningText?: string;
        turnId?: string;
        success?: boolean;
    };
    id?: string;
    timestamp?: string;
    parentId?: string;
}

export class TranscriptWatcher implements vscode.Disposable {
    private _client: DeviceClient;
    private _outputChannel: vscode.OutputChannel;
    private _watcher: fs.FSWatcher | null = null;
    private _dirWatcher: fs.FSWatcher | null = null;
    private _currentFile: string | null = null;
    private _fileOffset: number = 0;
    private _lineRemainder: string = '';
    private _terminalDisposables: vscode.Disposable[] = [];
    private _terminalExecutionActive: boolean = false;
    private _running: boolean = false;

    private _idleTimer: ReturnType<typeof setTimeout> | null = null;
    private _idleTimeout: number = 6000;
    private _watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    private _watchdogTimeout: number = 180000;
    private _waitingTimeout: number = 300000;

    private _lastState: AgentState | null = null;
    private _pendingApproval: boolean = false;
    private _pendingApprovalSince: number = 0;
    private _pendingToolCallIds: Set<string> = new Set();
    private _pendingApprovalIsOutsideReadOnly: boolean = false;
    private _approvalTimer: ReturnType<typeof setTimeout> | null = null;
    // Copilot emits toolRequests for both real approval prompts and tools that
    // are auto-approved. Some auto-approved tool_start events are only visible
    // to this extension several seconds later, so wait for a noticeable stall
    // before showing the yellow approval blink.
    private _approvalDelay: number = 4000;
    private _approvalScanTimer: ReturnType<typeof setInterval> | null = null;
    private _approvalScanInterval: number = 500;

    private _pollTimer: ReturnType<typeof setInterval> | null = null;
    private _pollInterval: number = 1000;
    private _readApprovalRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    private _readApprovalRecoveryDelay: number = 3000;

    constructor(client: DeviceClient, outputChannel: vscode.OutputChannel) {
        this._client = client;
        this._outputChannel = outputChannel;
        this.reloadConfig();
    }

    reloadConfig() {
        const config = vscode.workspace.getConfiguration('agentAura');
        this._idleTimeout = config.get<number>('idleTimeout') ?? 6000;
    }

    start() {
        if (this._running) { return; }
        this.reloadConfig();

        const transcriptDir = this._findTranscriptDir();
        if (!transcriptDir) {
            this._outputChannel.appendLine('[TranscriptWatcher] Cannot locate Copilot transcript directory');
            return;
        }

        this._running = true;
        this._outputChannel.appendLine(`[TranscriptWatcher] Monitoring: ${transcriptDir}`);

        try {
            this._dirWatcher = fs.watch(transcriptDir, (eventType, filename) => {
                if (filename && filename.endsWith('.jsonl')) {
                    this._switchToFile(path.join(transcriptDir, filename));
                }
            });
        } catch (e) {
            this._outputChannel.appendLine(`[TranscriptWatcher] Cannot watch directory: ${e}`);
        }

        const latestFile = this._findLatestTranscript(transcriptDir);
        if (latestFile) {
            this._switchToFile(latestFile);
        }

        this._registerTerminalExecutionWatchers();
        this._pollTimer = setInterval(() => this._readNewLines(), this._pollInterval);
    }

    stop() {
        this._running = false;
        this._clearIdleTimer();
        this._clearWatchdog();
        this._cancelApprovalTimer();
        this._cancelApprovalScanTimer();
        this._clearReadApprovalRecoveryTimer();

        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
        }
        if (this._dirWatcher) {
            this._dirWatcher.close();
            this._dirWatcher = null;
        }
        for (const disposable of this._terminalDisposables) {
            disposable.dispose();
        }
        this._terminalDisposables = [];
        this._currentFile = null;
        this._lineRemainder = '';
        this._outputChannel.appendLine('[TranscriptWatcher] Stopped');
    }

    dispose() {
        this.stop();
    }

    private _findTranscriptDir(): string | null {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        const candidates = [
            path.join(homeDir, '.config', 'Code', 'User', 'workspaceStorage'),
            path.join(homeDir, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
            path.join(homeDir, '.config', 'VSCodium', 'User', 'workspaceStorage'),
        ];

        for (const baseDir of candidates) {
            if (!fs.existsSync(baseDir)) { continue; }
            const transcriptDir = this._scanForTranscriptDir(baseDir);
            if (transcriptDir) { return transcriptDir; }
        }
        return null;
    }

    private _scanForTranscriptDir(baseDir: string): string | null {
        try {
            const workspaceDirs = fs.readdirSync(baseDir);
            let bestDir: string | null = null;
            let bestMtime = 0;

            for (const dir of workspaceDirs) {
                const transcriptPath = path.join(baseDir, dir, 'GitHub.copilot-chat', 'transcripts');
                if (!fs.existsSync(transcriptPath)) { continue; }

                try {
                    const files = fs.readdirSync(transcriptPath).filter(file => file.endsWith('.jsonl'));
                    for (const file of files) {
                        const stat = fs.statSync(path.join(transcriptPath, file));
                        if (stat.mtimeMs > bestMtime) {
                            bestMtime = stat.mtimeMs;
                            bestDir = transcriptPath;
                        }
                    }
                } catch { /* skip inaccessible */ }
            }
            return bestDir;
        } catch {
            return null;
        }
    }

    private _findLatestTranscript(dir: string): string | null {
        try {
            const files = fs.readdirSync(dir).filter(file => file.endsWith('.jsonl'));
            let latestFile: string | null = null;
            let latestMtime = 0;

            for (const file of files) {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.mtimeMs > latestMtime) {
                    latestMtime = stat.mtimeMs;
                    latestFile = fullPath;
                }
            }
            return latestFile;
        } catch {
            return null;
        }
    }

    private _registerTerminalExecutionWatchers() {
        if (this._terminalDisposables.length > 0) { return; }

        try {
            if (vscode.window.onDidStartTerminalShellExecution) {
                this._terminalDisposables.push(
                    vscode.window.onDidStartTerminalShellExecution(() => {
                        if (!this._pendingApproval && this._lastState !== 'waiting') { return; }
                        this._terminalExecutionActive = true;
                        this._clearApproval();
                        this._setState('busy');
                        this._markActive();
                        this._outputChannel.appendLine('[TranscriptWatcher] → terminal execution_start (busy)');
                    })
                );
            }
            if (vscode.window.onDidEndTerminalShellExecution) {
                this._terminalDisposables.push(
                    vscode.window.onDidEndTerminalShellExecution(() => {
                        if (!this._terminalExecutionActive) { return; }
                        this._terminalExecutionActive = false;
                        this._clearApproval();
                        this._setState('running');
                        this._armIdleTimer();
                        this._outputChannel.appendLine('[TranscriptWatcher] → terminal execution_end (running)');
                    })
                );
            }
        } catch (e) {
            this._outputChannel.appendLine(`[TranscriptWatcher] Terminal execution watcher unavailable: ${e}`);
        }
    }

    private _switchToFile(filePath: string) {
        if (this._currentFile === filePath) { return; }

        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
        }

        this._currentFile = filePath;
        this._lineRemainder = '';
        try {
            this._fileOffset = fs.statSync(filePath).size;
        } catch {
            this._fileOffset = 0;
        }

        this._outputChannel.appendLine(`[TranscriptWatcher] Watching: ${path.basename(filePath)}`);

        try {
            this._watcher = fs.watch(filePath, eventType => {
                if (eventType === 'change') {
                    this._readNewLines();
                }
            });
        } catch (e) {
            this._outputChannel.appendLine(`[TranscriptWatcher] Cannot watch file: ${e}`);
        }
    }

    private _readNewLines() {
        if (!this._currentFile) { return; }

        try {
            const stat = fs.statSync(this._currentFile);
            if (stat.size < this._fileOffset) {
                this._fileOffset = 0;
                this._lineRemainder = '';
            }
            if (stat.size <= this._fileOffset) { return; }

            const fd = fs.openSync(this._currentFile, 'r');
            const buffer = Buffer.alloc(stat.size - this._fileOffset);
            fs.readSync(fd, buffer, 0, buffer.length, this._fileOffset);
            fs.closeSync(fd);
            this._fileOffset = stat.size;

            const text = this._lineRemainder + buffer.toString('utf-8');
            const endedWithNewline = text.endsWith('\n');
            const parts = text.split('\n');
            const tail = endedWithNewline ? '' : (parts.pop() || '');
            this._lineRemainder = '';

            for (const line of parts) {
                if (!line.trim()) { continue; }
                this._handleJsonLine(line, false);
            }
            if (tail.trim()) {
                this._handleJsonLine(tail, true);
            }
        } catch (e) {
            this._outputChannel.appendLine(`[TranscriptWatcher] Read error: ${e}`);
        }
    }

    private _handleJsonLine(line: string, allowRemainder: boolean) {
        try {
            const event: TranscriptEvent = JSON.parse(line);
            this._handleEvent(event);
        } catch {
            if (allowRemainder) {
                this._lineRemainder = line;
            }
        }
    }

    private _handleEvent(event: TranscriptEvent) {
        switch (event.type) {
            case 'user.message':
                this._clearApproval();
                this._setState('running');
                this._markActive();
                void this._client.sendMessage('收到新的 Copilot 请求', 'activity', 20);
                this._outputChannel.appendLine('[TranscriptWatcher] → user.message (running)');
                break;

            case 'assistant.turn_start':
                if (this._pendingApproval) { break; }
                this._setState('running');
                this._markActive();
                this._outputChannel.appendLine('[TranscriptWatcher] → turn_start (running)');
                break;

            case 'assistant.message':
                if (this._hasToolRequests(event)) {
                    if (this._hasApprovalToolRequests(event)) {
                        this._scheduleApprovalCheck(event);
                        this._outputChannel.appendLine('[TranscriptWatcher] → assistant.message toolRequests (pending approval)');
                    } else {
                        this._clearApproval();
                        this._setState('running');
                        this._markActive();
                        this._outputChannel.appendLine('[TranscriptWatcher] → assistant.message read-only toolRequests (running)');
                    }
                } else {
                    this._clearApproval();
                    this._setState('running');
                    this._markActive();
                    this._outputChannel.appendLine('[TranscriptWatcher] → assistant.message (running)');
                }
                break;

            case 'tool.execution_start':
                this._clearApproval();
                this._setState('busy');
                this._markActive();
                void this._client.sendMessage(`正在运行 ${event.data?.toolName || '工具'}`, 'activity', 20);
                this._outputChannel.appendLine(`[TranscriptWatcher] → tool_start: ${event.data?.toolName || 'unknown'} (busy)`);
                break;

            case 'tool.execution_complete':
                this._terminalExecutionActive = false;
                this._clearApproval();
                this._setState('running');
                this._armIdleTimer();
                void this._client.sendMessage(`${event.data?.toolName || '工具'}执行完成`, 'success', 40);
                this._outputChannel.appendLine('[TranscriptWatcher] → tool_complete (running)');
                break;

            case 'assistant.turn_end':
                if (this._pendingApproval) { break; }
                this._armIdleTimer();
                void this._client.sendMessage('Copilot 任务已完成', 'success', 40);
                break;
        }
    }

    private _hasToolRequests(event: TranscriptEvent): boolean {
        const toolRequests = event.data?.toolRequests;
        return Array.isArray(toolRequests) && toolRequests.length > 0;
    }

    private _hasApprovalToolRequests(event: TranscriptEvent): boolean {
        const toolRequests = event.data?.toolRequests;
        if (!Array.isArray(toolRequests)) { return false; }

        return toolRequests.some(request => {
            const name = request.name || '';
            return name === 'run_in_terminal'
                || name === 'send_to_terminal'
                || name === 'apply_patch'
                || name === 'create_file'
                || name === 'multi_replace_string_in_file'
                || name === 'replace_string_in_file'
                || this._isOutsideWorkspaceReadRequest(request);
        });
    }

    private _scheduleApprovalCheck(event: TranscriptEvent) {
        this._pendingApproval = true;
        this._pendingApprovalIsOutsideReadOnly = this._isOutsideWorkspaceReadOnlyApproval(event);
        const eventTime = event.timestamp ? Date.parse(event.timestamp) : NaN;
        this._pendingApprovalSince = Number.isFinite(eventTime) ? eventTime : Date.now();
        this._pendingToolCallIds = new Set(
            (event.data?.toolRequests || [])
                .map(request => request.toolCallId)
                .filter((id): id is string => typeof id === 'string' && id.length > 0)
        );

        this._cancelApprovalTimer();
        this._cancelApprovalScanTimer();
        this._clearIdleTimer();
        this._clearWatchdog();
        this._startApprovalScan();

        this._approvalTimer = setTimeout(() => {
            this._readNewLines();
            if (this._pendingApproval && this._hasPendingToolExecutedInTranscript()) {
                this._clearApproval();
                this._setState('busy');
                this._markActive();
                this._outputChannel.appendLine('[TranscriptWatcher] → tool execution detected by transcript scan (busy)');
                return;
            }

            if (this._pendingApproval) {
                this._setState('waiting');
                void this._client.sendMessage('Copilot 等待操作授权', 'warning', 60, 10_000);
                this._outputChannel.appendLine('[TranscriptWatcher] → waiting for approval (blink)');
                this._armWatchdog(this._waitingTimeout);
                if (this._pendingApprovalIsOutsideReadOnly) {
                    this._armReadApprovalRecoveryTimer();
                }
            }
        }, this._approvalDelay);
    }

    private _clearApproval() {
        this._pendingApproval = false;
        this._pendingApprovalSince = 0;
        this._pendingToolCallIds.clear();
        this._pendingApprovalIsOutsideReadOnly = false;
        this._cancelApprovalTimer();
        this._cancelApprovalScanTimer();
        this._clearReadApprovalRecoveryTimer();
    }

    private _startApprovalScan() {
        this._approvalScanTimer = setInterval(() => {
            if (!this._pendingApproval) {
                this._cancelApprovalScanTimer();
                return;
            }
            this._readNewLines();
            if (this._pendingApproval && this._hasPendingToolExecutedInTranscript()) {
                this._clearApproval();
                this._setState('busy');
                this._markActive();
                this._outputChannel.appendLine('[TranscriptWatcher] → tool execution detected by approval scan (busy)');
            }
        }, this._approvalScanInterval);
    }

    private _hasPendingToolExecutedInTranscript(): boolean {
        if (!this._currentFile || !this._pendingApprovalSince) { return false; }

        try {
            const stat = fs.statSync(this._currentFile);
            const tailSize = Math.min(stat.size, 256 * 1024);
            const fd = fs.openSync(this._currentFile, 'r');
            const buffer = Buffer.alloc(tailSize);
            fs.readSync(fd, buffer, 0, tailSize, stat.size - tailSize);
            fs.closeSync(fd);

            const cutoff = this._pendingApprovalSince - 1000;
            const events = this._parseJsonLines(buffer.toString('utf-8'));
            return events.some(event => {
                if (event.type !== 'tool.execution_start' && event.type !== 'tool.execution_complete') { return false; }
                if (!event.timestamp) { return false; }
                const eventTime = Date.parse(event.timestamp);
                if (!Number.isFinite(eventTime) || eventTime < cutoff) { return false; }

                const toolCallId = event.data?.toolCallId;
                return this._pendingToolCallIds.size === 0 || (typeof toolCallId === 'string' && this._pendingToolCallIds.has(toolCallId));
            });
        } catch (e) {
            this._outputChannel.appendLine(`[TranscriptWatcher] Tool execution scan error: ${e}`);
            return false;
        }
    }

    private _parseJsonLines(text: string): TranscriptEvent[] {
        const events: TranscriptEvent[] = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) { continue; }
            try {
                events.push(JSON.parse(line) as TranscriptEvent);
            } catch { /* skip partial tail */ }
        }
        return events;
    }

    private _cancelApprovalTimer() {
        if (this._approvalTimer) {
            clearTimeout(this._approvalTimer);
            this._approvalTimer = null;
        }
    }

    private _cancelApprovalScanTimer() {
        if (this._approvalScanTimer) {
            clearInterval(this._approvalScanTimer);
            this._approvalScanTimer = null;
        }
    }

    private _armReadApprovalRecoveryTimer() {
        this._clearReadApprovalRecoveryTimer();
        this._readApprovalRecoveryTimer = setTimeout(() => {
            if (!this._pendingApproval || !this._pendingApprovalIsOutsideReadOnly || this._lastState !== 'waiting') { return; }
            this._clearApproval();
            this._setState('running');
            this._markActive();
            this._outputChannel.appendLine('[TranscriptWatcher] → outside read approval recovery (running)');
        }, this._readApprovalRecoveryDelay);
    }

    private _clearReadApprovalRecoveryTimer() {
        if (this._readApprovalRecoveryTimer) {
            clearTimeout(this._readApprovalRecoveryTimer);
            this._readApprovalRecoveryTimer = null;
        }
    }

    private _isOutsideWorkspaceReadOnlyApproval(event: TranscriptEvent): boolean {
        const toolRequests = event.data?.toolRequests;
        if (!Array.isArray(toolRequests) || toolRequests.length === 0) { return false; }
        return toolRequests.every(request => this._isOutsideWorkspaceReadRequest(request));
    }

    private _isOutsideWorkspaceReadRequest(request: ToolRequest): boolean {
        const name = request.name || '';
        if (name !== 'read_file' && name !== 'view_image') { return false; }

        const args = this._parseToolArguments(request.arguments);
        const rawPath = args.filePath || args.path;
        if (typeof rawPath !== 'string' || rawPath.length === 0) { return false; }

        const normalizedPath = this._normalizeToolPath(rawPath);
        if (!path.isAbsolute(normalizedPath)) { return false; }

        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        if (workspaceFolders.length === 0) { return true; }

        return !workspaceFolders.some(folder => this._isPathInside(normalizedPath, folder.uri.fsPath));
    }

    private _parseToolArguments(args: unknown): Record<string, unknown> {
        if (!args) { return {}; }
        if (typeof args === 'string') {
            try { return JSON.parse(args) as Record<string, unknown>; } catch { return {}; }
        }
        if (typeof args === 'object') { return args as Record<string, unknown>; }
        return {};
    }

    private _normalizeToolPath(rawPath: string): string {
        if (rawPath.startsWith('file://')) {
            try { return vscode.Uri.parse(rawPath).fsPath; } catch { return rawPath; }
        }
        if (rawPath === '~') { return process.env.HOME || rawPath; }
        if (rawPath.startsWith('~/')) {
            const homeDir = process.env.HOME || '';
            return homeDir ? path.join(homeDir, rawPath.slice(2)) : rawPath;
        }
        return rawPath;
    }

    private _isPathInside(candidatePath: string, folderPath: string): boolean {
        const relative = path.relative(path.resolve(folderPath), path.resolve(candidatePath));
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    private _setState(state: AgentState) {
        if (state !== this._lastState) {
            this._lastState = state;
            this._client.sendAgentState(state);
        }
    }

    private _markActive() {
        this._clearIdleTimer();
        this._armWatchdog();
    }

    private _armIdleTimer() {
        this._clearIdleTimer();
        this._idleTimer = setTimeout(() => {
            if (this._lastState !== 'idle') {
                this._lastState = 'idle';
                this._client.sendAgentState('idle');
                this._outputChannel.appendLine('[TranscriptWatcher] → idle (turn finished)');
            }
        }, this._idleTimeout);
    }

    private _armWatchdog(timeout: number = this._watchdogTimeout) {
        this._clearWatchdog();
        this._watchdogTimer = setTimeout(() => {
            if (this._lastState !== 'idle') {
                this._lastState = 'idle';
                this._client.sendAgentState('idle');
                this._outputChannel.appendLine('[TranscriptWatcher] → idle (watchdog)');
            }
        }, timeout);
    }

    private _clearWatchdog() {
        if (this._watchdogTimer) {
            clearTimeout(this._watchdogTimer);
            this._watchdogTimer = null;
        }
    }

    private _clearIdleTimer() {
        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
    }
}
