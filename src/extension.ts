import * as vscode from 'vscode';
import { promises as fsp } from 'fs';
import { Poller, readWindow } from './core';

const SCHEME = 'polltail';

interface FileState {
  follow: boolean;
  readOnly: boolean;
  /** Follow was switched off automatically because the user scrolled up. */
  autoPaused: boolean;
  /** Bumped to force VS Code to re-stat/re-resolve the file (for example after a read-only toggle). */
  generation: number;
  /** The file is larger than polltail.maxBytes, so only its tail is shown (and it is forced read-only). */
  truncated: boolean;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('polltail');
}

function maxBytes(): number {
  return cfg().get<number>('maxBytes', 20971520);
}

function realPath(uri: vscode.Uri): string {
  return uri.with({ scheme: 'file' }).fsPath;
}

function virtualUri(path: string): vscode.Uri {
  return vscode.Uri.file(path).with({ scheme: SCHEME });
}

function mapError(uri: vscode.Uri, e: unknown): vscode.FileSystemError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    return vscode.FileSystemError.FileNotFound(uri);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return vscode.FileSystemError.NoPermissions(uri);
  }
  if (code === 'EISDIR') {
    return vscode.FileSystemError.FileIsADirectory(uri);
  }
  return vscode.FileSystemError.Unavailable(e instanceof Error ? e.message : String(e));
}

/**
 * Serves real files under the `polltail:` scheme. Because the editor reads the file through this
 * provider and we fire change events from our own timer, updates never depend on VS Code's file
 * watcher (and so never depend on inotify capacity).
 */
class PollTailProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changeEmitter.event;

  private readonly stateEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeState = this.stateEmitter.event;

  private readonly states = new Map<string, FileState>();
  private readonly poller: Poller;

  constructor() {
    this.poller = new Poller(
      () => cfg().get<number>('pollIntervalMs', 1000),
      (p) => this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: virtualUri(p) }])
    );
    this.poller.start();
  }

  dispose(): void {
    this.poller.stop();
    this.changeEmitter.dispose();
    this.stateEmitter.dispose();
  }

  // ---- state ----

  state(uri: vscode.Uri): FileState {
    const key = realPath(uri);
    let s = this.states.get(key);
    if (!s) {
      s = {
        follow: cfg().get<boolean>('defaultFollow', true),
        readOnly: cfg().get<boolean>('defaultReadOnly', true),
        autoPaused: false,
        generation: 0,
        truncated: false,
      };
      this.states.set(key, s);
    }
    return s;
  }

  notify(uri: vscode.Uri): void {
    this.stateEmitter.fire(uri);
  }

  track(uri: vscode.Uri): void {
    this.poller.add(realPath(uri));
  }

  untrack(uri: vscode.Uri): void {
    const key = realPath(uri);
    this.poller.remove(key);
    this.states.delete(key);
  }

  /** Force the editor to re-stat and re-read the file. */
  refresh(uri: vscode.Uri): void {
    this.state(uri).generation++;
    this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    this.notify(uri);
  }

  // ---- FileSystemProvider ----

  watch(): vscode.Disposable {
    // We poll ourselves; there is nothing for VS Code to watch.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    let st;
    try {
      st = await fsp.stat(realPath(uri));
    } catch (e) {
      throw mapError(uri, e);
    }
    if (!st.isFile()) {
      return { type: vscode.FileType.Directory, ctime: st.ctimeMs, mtime: st.mtimeMs, size: 0 };
    }
    const max = maxBytes();
    const truncated = max > 0 && st.size > max;
    const s = this.state(uri);
    s.truncated = truncated;
    const readOnly = s.readOnly || truncated;
    return {
      type: vscode.FileType.File,
      ctime: st.ctimeMs,
      mtime: st.mtimeMs + s.generation,
      size: truncated ? max : st.size,
      permissions: readOnly ? vscode.FilePermission.Readonly : undefined,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const r = await readWindow(realPath(uri), maxBytes());
      this.state(uri).truncated = r.truncated;
      return r.data;
    } catch (e) {
      throw mapError(uri, e);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const path = realPath(uri);
    let exists = true;
    let size = 0;
    try {
      size = (await fsp.stat(path)).size;
    } catch {
      exists = false;
    }
    if (exists && options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const max = maxBytes();
    if (this.state(uri).readOnly || (max > 0 && size > max)) {
      // Never write a partial (tail-window) view back over the real file.
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    try {
      await fsp.writeFile(path, content);
    } catch (e) {
      throw mapError(uri, e);
    }
    this.poller.markSeen(path);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PollTailProvider();
  context.subscriptions.push(
    provider,
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, {
      isCaseSensitive: process.platform === 'linux',
    })
  );

  // ---- track open documents ----
  const consider = (d: vscode.TextDocument): void => {
    if (d.uri.scheme === SCHEME) {
      provider.track(d.uri);
    }
  };
  vscode.workspace.textDocuments.forEach(consider);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(consider),
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (d.uri.scheme === SCHEME) {
        provider.untrack(d.uri);
      }
    })
  );

  // ---- status bar ----
  const followItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  followItem.command = 'polltail.toggleFollow';
  const roItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  roItem.command = 'polltail.toggleReadOnly';
  const tailItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  context.subscriptions.push(followItem, roItem, tailItem);

  const activePollTail = (): vscode.TextEditor | undefined => {
    const ed = vscode.window.activeTextEditor;
    return ed && ed.document.uri.scheme === SCHEME ? ed : undefined;
  };

  const updateStatus = (): void => {
    const ed = activePollTail();
    if (!ed) {
      followItem.hide();
      roItem.hide();
      tailItem.hide();
      return;
    }
    const s = provider.state(ed.document.uri);
    if (s.follow) {
      followItem.text = '$(arrow-down) Follow';
      followItem.tooltip = 'Following new content. Click to turn follow off.';
    } else if (s.autoPaused) {
      followItem.text = '$(debug-pause) Follow paused';
      followItem.tooltip = 'Paused because you scrolled up. Scroll to the end to resume, or click to turn follow on.';
    } else {
      followItem.text = '$(circle-slash) Follow off';
      followItem.tooltip = 'Not following. Click to turn follow on.';
    }
    const readOnly = s.readOnly || s.truncated;
    roItem.text = readOnly ? '$(lock) Read-only' : '$(edit) Read-write';
    roItem.tooltip = readOnly
      ? 'Read-only. Click to allow editing and saving.'
      : 'Read-write. Saving overwrites the whole file. Click to make read-only.';
    followItem.show();
    roItem.show();
    if (s.truncated) {
      tailItem.text = '$(warning) Tail window';
      tailItem.tooltip = `File is larger than polltail.maxBytes; showing only the last ${maxBytes()} bytes. Forced read-only.`;
      tailItem.show();
    } else {
      tailItem.hide();
    }
  };
  context.subscriptions.push(
    provider.onDidChangeState(updateStatus),
    vscode.window.onDidChangeActiveTextEditor(updateStatus)
  );
  updateStatus();

  // ---- follow behaviour ----
  let guardUntil = 0; // ignore visible-range events caused by our own scrolling

  const revealEnd = (ed: vscode.TextEditor, placeCursor: boolean): void => {
    const last = Math.max(0, ed.document.lineCount - 1);
    const pos = new vscode.Position(last, ed.document.lineAt(last).text.length);
    if (placeCursor) {
      ed.selection = new vscode.Selection(pos, pos);
    }
    guardUntil = Date.now() + 300;
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.Default);
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const d = e.document;
      if (d.uri.scheme !== SCHEME || e.contentChanges.length === 0) {
        return;
      }
      if (provider.state(d.uri).follow) {
        for (const ed of vscode.window.visibleTextEditors) {
          if (ed.document === d) {
            revealEnd(ed, false);
          }
        }
      }
      updateStatus();
    }),

    // Pause follow when the user scrolls away from the end (like `less +F`), resume when they return.
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const d = e.textEditor.document;
      if (d.uri.scheme !== SCHEME || Date.now() < guardUntil || e.visibleRanges.length === 0) {
        return;
      }
      const s = provider.state(d.uri);
      const last = d.lineCount - 1;
      const visibleEnd = Math.max(...e.visibleRanges.map((r) => r.end.line));
      const atEnd = visibleEnd >= last;
      if (s.follow && !atEnd) {
        s.follow = false;
        s.autoPaused = true;
        provider.notify(d.uri);
      } else if (!s.follow && s.autoPaused && atEnd) {
        s.follow = true;
        s.autoPaused = false;
        provider.notify(d.uri);
      }
    })
  );

  // ---- commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('polltail.open', async (arg?: unknown) => {
      let target = arg instanceof vscode.Uri ? arg : undefined;
      if (!target) {
        const active = vscode.window.activeTextEditor?.document.uri;
        if (active && active.scheme === 'file') {
          target = active;
        }
      }
      if (!target) {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open with Poll Tail' });
        target = picked?.[0];
      }
      if (!target) {
        return;
      }
      const uri = target.with({ scheme: SCHEME });
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const ed = await vscode.window.showTextDocument(doc, { preview: false });
        if (provider.state(uri).follow) {
          revealEnd(ed, true);
        }
        updateStatus();
      } catch (e) {
        void vscode.window.showErrorMessage(`Poll Tail could not open ${target.fsPath}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),

    vscode.commands.registerCommand('polltail.toggleFollow', () => {
      const ed = activePollTail();
      if (!ed) {
        return;
      }
      const s = provider.state(ed.document.uri);
      s.follow = !s.follow;
      s.autoPaused = false;
      if (s.follow) {
        revealEnd(ed, false);
      }
      provider.notify(ed.document.uri);
    }),

    vscode.commands.registerCommand('polltail.toggleReadOnly', () => {
      const ed = activePollTail();
      if (!ed) {
        return;
      }
      const s = provider.state(ed.document.uri);
      if (s.truncated) {
        void vscode.window.showWarningMessage(
          'This file is larger than polltail.maxBytes, so only its tail is shown and it stays read-only. Raise polltail.maxBytes (or set it to 0) to edit it.'
        );
        return;
      }
      s.readOnly = !s.readOnly;
      provider.refresh(ed.document.uri); // bumps the reported mtime so the editor re-reads the permission
    }),

    vscode.commands.registerCommand('polltail.reload', () => {
      const ed = activePollTail();
      if (ed) {
        provider.refresh(ed.document.uri);
      }
    })
  );
}

export function deactivate(): void {
  // Disposables are registered on the extension context.
}
