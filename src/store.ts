/**
 * Holds what the panel and status bar show, and runs git operations one at a time, reporting each
 * outcome through `notify`.
 */
import type { Change, HistoryEntry, Repository, Snapshot, UnfinishedState } from './git/repository.ts';

export interface StoreSources {
	/** The Repository containing the vault, or null when there is none. */
	find(): Promise<Repository | null>;
	init(): Promise<Repository>;
	/** Moves a vault file to trash, following the user's Obsidian deletion setting. */
	trash(vaultPath: string): Promise<void>;
	notify(message: string): void;
}

export type Operation = 'commit' | 'commit-push' | 'pull' | 'push' | 'discard' | 'init';

const UNFINISHED_TEXT: Record<UnfinishedState, string> = {
	merge: 'The repository is in the middle of a merge. Finish it in a terminal.',
	rebase: 'The repository is in the middle of a rebase. Finish it in a terminal.',
	'cherry-pick': 'The repository is in the middle of a cherry-pick. Finish it in a terminal.',
	revert: 'The repository is in the middle of a revert. Finish it in a terminal.',
	detached: 'HEAD is detached, so there is no branch to commit to. Switch to a branch in a terminal.',
};

/** The message used when the commit box is left empty, such as "Vault update 2026-10-31 14:05". */
export function defaultMessage(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `Vault update ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export class GitStore {
	repository: Repository | null = null;
	snapshot: Snapshot | null = null;
	history: HistoryEntry[] = [];
	/** True once the first lookup for a Repository has finished. */
	loaded = false;
	/** Why the last refresh failed, such as git not being installed. */
	error: string | null = null;
	/** The operation in progress, if any. */
	busy: Operation | null = null;
	/** True when the last Fetch failed, so the Behind count may be stale. */
	fetchFailed = false;
	/** Vault paths of Changes the user unticked; a path is forgotten once it is no longer a Change. */
	private readonly unselected = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private refreshing: Promise<void> | null = null;
	private refreshAgain = false;
	private fetching: Promise<void> | null = null;
	private readonly sources: StoreSources;

	constructor(sources: StoreSources) {
		this.sources = sources;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get changes(): Change[] {
		return this.snapshot?.changes ?? [];
	}

	get hasRemote(): boolean {
		return (this.snapshot?.remotes.length ?? 0) > 0;
	}

	/** Why Commit, Pull and Push are disabled, or null when they are not. */
	get blockedReason(): string | null {
		const unfinished = this.snapshot?.unfinished;
		return unfinished ? UNFINISHED_TEXT[unfinished] : null;
	}

	isSelected(change: Change): boolean {
		return !this.unselected.has(change.vaultPath);
	}

	setSelected(change: Change, selected: boolean): void {
		if (selected) this.unselected.delete(change.vaultPath);
		else this.unselected.add(change.vaultPath);
		this.emit();
	}

	setAllSelected(selected: boolean): void {
		this.unselected.clear();
		if (!selected) for (const change of this.changes) this.unselected.add(change.vaultPath);
		this.emit();
	}

	get selectedChanges(): Change[] {
		return this.changes.filter((change) => this.isSelected(change));
	}

	/** Rereads the Repository's state. Calls made while one is running are folded into a single rerun. */
	async refresh(): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return this.refreshing;
		}
		this.refreshing = (async () => {
			do {
				this.refreshAgain = false;
				await this.load();
			} while (this.refreshAgain);
		})();
		try {
			await this.refreshing;
		} finally {
			this.refreshing = null;
		}
	}

	/** A refresh from a vault event, skipped while an operation runs since that refreshes when done. */
	refreshIfIdle(): void {
		if (!this.busy) void this.refresh();
	}

	private async load(): Promise<void> {
		try {
			this.repository = await this.sources.find();
			this.snapshot = this.repository ? await this.repository.snapshot() : null;
			this.history = this.repository && this.snapshot ? await this.repository.history(this.snapshot) : [];
			this.error = null;
		} catch (error) {
			this.error = messageOf(error);
		}
		this.loaded = true;
		const current = new Set(this.changes.map((change) => change.vaultPath));
		for (const path of this.unselected) if (!current.has(path)) this.unselected.delete(path);
		this.emit();
	}

	/** Updates the Behind count; skipped without an Upstream or while an operation runs. Failures stay quiet. */
	async fetch(): Promise<void> {
		const { repository, snapshot } = this;
		if (!repository || !snapshot?.upstream || this.busy || this.fetching) return;
		this.fetching = (async () => {
			try {
				await repository.fetch();
				this.fetchFailed = false;
			} catch {
				this.fetchFailed = true;
			}
		})();
		await this.fetching;
		this.fetching = null;
		await this.refresh();
	}

	async init(): Promise<void> {
		await this.operate('init', async () => {
			this.repository = await this.sources.init();
			this.sources.notify('Initialized a git repository in this vault.');
		});
	}

	/** Commits the selected Changes; an empty `message` falls back to the default. Resolves true on success. */
	async commit(message: string): Promise<boolean> {
		let committed = false;
		await this.operate('commit', async () => {
			committed = await this.commitSelected(message);
		});
		return committed;
	}

	/** Commits, then pushes if there is a Remote; a failed push keeps the commit. */
	async commitAndPush(message: string): Promise<boolean> {
		let committed = false;
		await this.operate('commit-push', async (repository) => {
			committed = await this.commitSelected(message);
			if (!committed || !this.hasRemote) return;
			try {
				await this.pushNow(repository);
			} catch (error) {
				this.sources.notify(`Committed, but the push failed: ${messageOf(error)}`);
			}
		});
		return committed;
	}

	async pull(): Promise<void> {
		await this.operate('pull', async (repository) => {
			if (!this.snapshot?.upstream) {
				this.sources.notify('This branch has no upstream yet. Push it once to set one.');
				return;
			}
			const result = await repository.pull();
			if (result.kind === 'conflict') {
				this.sources.notify(`Pull hit conflicts in ${result.paths.join(', ')}, so nothing was changed. Resolve them in a terminal.`);
			} else if (result.commits === 0) {
				this.sources.notify('Already up to date.');
			} else {
				this.sources.notify(`Pulled ${result.commits} ${result.commits === 1 ? 'commit' : 'commits'}.`);
			}
		});
	}

	async push(): Promise<void> {
		await this.operate('push', (repository) => this.pushNow(repository));
	}

	async discard(change: Change): Promise<void> {
		await this.operate('discard', async (repository) => {
			if (!this.snapshot) return;
			await repository.discard(change, this.snapshot, (path) => this.sources.trash(path));
			this.sources.notify(`Discarded changes to ${change.vaultPath}.`);
		});
	}

	private async commitSelected(message: string): Promise<boolean> {
		const repository = this.repository;
		const selected = this.selectedChanges;
		if (!repository) return false;
		if (selected.length === 0) {
			this.sources.notify('Select at least one change to commit.');
			return false;
		}
		const hash = await repository.commit(selected, message.trim() || defaultMessage(new Date()));
		this.sources.notify(`Committed ${selected.length} ${selected.length === 1 ? 'file' : 'files'} (${hash}).`);
		return true;
	}

	private async pushNow(repository: Repository): Promise<void> {
		const snapshot = this.snapshot ?? (await repository.snapshot());
		await repository.push(snapshot);
		const upstream = (await repository.snapshot()).upstream;
		this.sources.notify(upstream ? `Pushed to ${upstream}.` : 'Pushed.');
	}

	/**
	 * Runs one operation with the lock held, then refreshes. Anything but Initialize needs a Repository, and
	 * Commit, Pull and Push need it to be on a branch with nothing unfinished.
	 */
	private async operate(operation: Operation, run: (repository: Repository) => Promise<void>): Promise<void> {
		if (this.busy) {
			this.sources.notify('Git is busy. Try again in a moment.');
			return;
		}
		const repository = this.repository;
		if (operation !== 'init') {
			if (!repository) {
				this.sources.notify('This vault is not in a git repository.');
				return;
			}
			const blocked = this.blockedReason;
			if (blocked && operation !== 'discard') {
				this.sources.notify(blocked);
				return;
			}
		}
		this.busy = operation;
		this.emit();
		try {
			// A background fetch updates the same refs that pull and push do.
			await this.fetching;
			await run(repository as Repository);
		} catch (error) {
			this.sources.notify(messageOf(error));
		} finally {
			this.busy = null;
			await this.refresh();
		}
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
