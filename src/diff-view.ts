import { ItemView, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type { Diff } from './git/parse.ts';
import type { Change } from './git/repository.ts';
import type { GitStore } from './store.ts';

export const DIFF_VIEW_TYPE = 'my-git-diff';

/** What a diff tab shows: a Change against the last commit, or one file in one commit. */
export interface DiffState {
	change: Change;
	/** Set for a file in a commit from the history. */
	commit?: { hash: string; shortHash: string };
}

/** A read-only tab showing one file's added and removed lines. */
export class DiffView extends ItemView {
	private readonly store: GitStore;
	private state: DiffState | null = null;

	constructor(leaf: WorkspaceLeaf, store: GitStore) {
		super(leaf);
		this.store = store;
	}

	getViewType(): string {
		return DIFF_VIEW_TYPE;
	}

	getDisplayText(): string {
		if (!this.state) return 'Diff';
		const name = this.state.change.vaultPath.split('/').pop() ?? '';
		return this.state.commit ? `${name} @ ${this.state.commit.shortHash}` : `${name} (diff)`;
	}

	getIcon(): string {
		return 'file-diff';
	}

	async onOpen(): Promise<void> {
		// A Change's diff follows edits to the file; a commit's never changes.
		this.register(
			this.store.subscribe(() => {
				if (this.state && !this.state.commit && !this.store.busy) void this.show();
			}),
		);
	}

	getState(): Record<string, unknown> {
		return { ...this.state };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const next = state as Partial<DiffState> | null;
		if (next?.change) this.state = { change: next.change, commit: next.commit };
		await super.setState(state, result);
		await this.show();
	}

	/** Reloads the diff, for when the file changed while the tab was open. */
	async show(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('my-git-diff');
		const state = this.state;
		if (!state) return;
		// The tab title is read once when the view opens, before any state arrives. updateHeader is not in the
		// public API, so it is called only if present.
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		const { change, commit } = state;

		const header = root.createDiv({ cls: 'my-git-diff-header' });
		header.createDiv({ cls: 'my-git-diff-path', text: change.fromVaultPath ? `${change.fromVaultPath} → ${change.vaultPath}` : change.vaultPath });
		header.createDiv({ cls: 'my-git-diff-source', text: commit ? `In commit ${commit.shortHash}` : 'Compared with the last commit' });

		const repository = this.store.repository;
		if (!repository) {
			root.createDiv({ cls: 'my-git-empty', text: 'This vault is not in a git repository.' });
			return;
		}
		let diff: Diff;
		try {
			if (commit) {
				diff = await repository.commitDiff(commit.hash, change);
			} else {
				const snapshot = this.store.snapshot ?? (await repository.snapshot());
				diff = await repository.changeDiff(change, snapshot);
			}
		} catch (error) {
			root.createDiv({ cls: 'my-git-banner mod-error', text: error instanceof Error ? error.message : String(error) });
			return;
		}
		if (diff.binary) {
			root.createDiv({ cls: 'my-git-empty', text: 'Binary file changed.' });
			return;
		}
		if (diff.lines.length === 0) {
			root.createDiv({ cls: 'my-git-empty', text: change.kind === 'renamed' ? 'Renamed with no other changes.' : 'No differences.' });
			return;
		}
		const body = root.createDiv({ cls: 'my-git-diff-body' });
		for (const line of diff.lines) {
			const el = body.createDiv({ cls: `my-git-diff-line is-${line.type}` });
			const marker = line.type === 'add' ? '+' : line.type === 'del' ? '−' : '';
			el.createSpan({ cls: 'my-git-diff-marker', text: marker });
			el.createSpan({ cls: 'my-git-diff-text', text: line.text });
		}
	}
}
