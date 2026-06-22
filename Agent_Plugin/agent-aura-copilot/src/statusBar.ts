/**
 * StatusBarUI - Shows device connection status in the VS Code status bar.
 *
 * Displays: connection state, current agent state, and provides quick actions.
 */

import * as vscode from 'vscode';
import { DeviceClient } from './deviceClient';
import { AgentState } from './stateMapper';

const STATE_ICONS: Record<AgentState, string> = {
    running: '$(play)',
    busy: '$(loading~spin)',
    waiting: '$(bell)',
    error: '$(error)',
    idle: '$(circle-outline)',
    init: '$(sparkle)',
    offline: '$(debug-disconnect)',
    upgrade: '$(cloud-download)',
};

const STATE_COLORS: Record<AgentState, vscode.ThemeColor | undefined> = {
    running: new vscode.ThemeColor('statusBarItem.prominentForeground'),
    busy: new vscode.ThemeColor('statusBarItem.warningForeground'),
    waiting: new vscode.ThemeColor('statusBarItem.warningForeground'),
    error: new vscode.ThemeColor('statusBarItem.errorForeground'),
    idle: undefined,
    init: new vscode.ThemeColor('statusBarItem.prominentForeground'),
    offline: undefined,
    upgrade: new vscode.ThemeColor('statusBarItem.warningForeground'),
};

export class StatusBarUI implements vscode.Disposable {
    private _item: vscode.StatusBarItem;
    private _client: DeviceClient;
    private _disposables: vscode.Disposable[] = [];

    constructor(client: DeviceClient) {
        this._client = client;
        this._item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this._item.command = 'agentAura.setState';
        this._item.name = 'AgentAura Ring Light';

        // Listen for connection changes
        this._disposables.push(
            client.onDidChangeConnection(() => this.update())
        );

        this.update();
    }

    update() {
        const config = vscode.workspace.getConfiguration('agentAura');
        if (!config.get<boolean>('showStatusBar')) {
            this._item.hide();
            return;
        }

        if (!this._client.connected) {
            this._item.text = '$(circle-slash) Ring Light';
            this._item.tooltip = 'AgentAura: Not connected. Click to set state.';
            this._item.color = undefined;
            this._item.command = 'agentAura.connect';
        } else {
            const state = this._client.lastState || 'idle';
            const icon = STATE_ICONS[state] || '$(circle-outline)';
            this._item.text = `${icon} Ring: ${state}`;
            this._item.tooltip = `AgentAura: Connected (${this._client.transport}://${this._client.host})\nState: ${state}\nClick to change state`;
            this._item.color = STATE_COLORS[state];
            this._item.command = 'agentAura.setState';
        }

        this._item.show();
    }

    dispose() {
        this._item.dispose();
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
