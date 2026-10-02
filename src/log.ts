import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/** The dedicated "IntelliCommit" log channel; created on first use. */
export function log(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('IntelliCommit', { log: true });
  return channel;
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}
