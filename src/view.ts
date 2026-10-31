import { ItemView, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { Change, HistoryEntry } from './git/repository.ts';
import type { ChangeKind } from './git/parse.ts';
import { defaultMessage, type GitStore, type Operation } from './store.ts';

export const GIT_VIEW_TYPE = 'my-git-panel';

export interface GitViewSources {
	store: GitStore;
	/** Opens the file in the editor, or its diff when the file no longer exists or is outside the vault index. */
	openChange: (change: Change) => void;
	openChangeDiff: (change: Change) => void;
	openCommitDiff: (entry: HistoryEntry, change: Change) => void;
	/** Asks for confirmation, then discards. */
	discard: (change: Change) => void;
}

/** The letter shown for each kind of Change. */
export const KIND_LETTER: Record<ChangeKind, string> = {
	modified: 'M',
	added: 'A',
	deleted: 'D',
	renamed: 'R',
	untracked: 'U',
	conflicted: 'C',
};

const KIND_LABEL: Record<ChangeKind, string> = {
	modified: 'Modified',
	added: 'Added',
	deleted: 'Deleted',
	renamed: 'Renamed',
	untracked: 'Untracked',
	conflicted: 'Conflicted',
};

/** Sidebar panel: the Changes to commit, a commit message box, Pull and Push, and recent history. */
export class GitView extends ItemView {
	private readonly sources: GitViewSources;
	private unsubscribe: (() => void) | null = null;
	/** Built once so the message being typed survives re-renders. */
	private message!: HTMLTextAreaElement;
	private bodyEl!: HTMLElement;
	private composerEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private historyEl!: HTMLElement;
	private historyOpen = false;
	/** Commits the user expanded, with their files once loaded. */
	private readonly expanded = new Map<string, Change[] | null>();

	constructor(leaf: WorkspaceLeaf, sources: GitViewSources) {
		super(leaf);
		this.sources = sources;
	}

	getViewType(): string {
		return GIT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Git';
	}

	getIcon(): string {
		return 'git-branch';
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('my-git');
		this.bodyEl = root.createDiv();
		this.composerEl = root.createDiv({ cls: 'my-git-composer' });
		this.message = this.composerEl.createEl('textarea', { cls: 'my-git-message', attr: { rows: '3', 'aria-label': 'Commit message' } });
		this.message.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void this.commit(false);
			}
		});
		this.actionsEl = this.composerEl.createDiv({ cls: 'my-git-actions' });
		this.historyEl = root.createDiv();
		this.unsubscribe = this.sources.store.subscribe(() => this.render());
		this.render();
		void this.sources.store.refresh();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private render(): void {
		const { store } = this.sources;
		const body = this.bodyEl;
		body.empty();
		this.renderHeader(body);

		if (store.error) body.createDiv({ cls: 'my-git-banner mod-error', text: store.error });
		if (!store.loaded) {
			this.composerEl.hide();
			this.historyEl.empty();
			return;
		}
		if (!store.snapshot) {
			this.composerEl.hide();
			this.historyEl.empty();
			if (!store.error) this.renderNoRepository(body);
			return;
		}
		const blocked = store.blockedReason;
		if (blocked) body.createDiv({ cls: 'my-git-banner mod-warning', text: blocked });

		this.renderChanges(body);
		this.composerEl.show();
		this.message.placeholder = defaultMessage(new Date());
		this.renderActions();
		this.renderHistory();
	}

	private renderHeader(root: HTMLElement): void {
		const { store } = this.sources;
		const header = root.createDiv({ cls: 'my-git-header' });
		header.createSpan({ cls: 'my-git-title', text: 'Git' });
		const snapshot = store.snapshot;
		const branch = snapshot ? (snapshot.branch ?? 'detached HEAD') : '';
		const branchEl = header.createSpan({ cls: 'my-git-branch' });
		if (branch) {
			setIcon(branchEl.createSpan({ cls: 'my-git-branch-icon' }), 'git-branch');
			branchEl.createSpan({ text: snapshot?.upstream ? `${branch} → ${snapshot.upstream}` : branch });
		}
		const refresh = header.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Refresh' } });
		setIcon(refresh, 'refresh-cw');
		refresh.addEventListener('click', () => {
			void store.refresh();
			void store.fetch();
		});
	}

	private renderNoRepository(root: HTMLElement): void {
		const empty = root.createDiv({ cls: 'my-git-empty' });
		empty.createDiv({ text: 'This vault is not in a git repository.' });
		const init = empty.createEl('button', { cls: 'mod-cta', text: 'Initialize repository' });
		init.disabled = this.sources.store.busy !== null;
		init.addEventListener('click', () => void this.sources.store.init());
	}

	private renderChanges(root: HTMLElement): void {
		const { store } = this.sources;
		const changes = store.changes;
		const section = root.createDiv({ cls: 'my-git-section' });
		const heading = section.createDiv({ cls: 'my-git-section-heading' });
		if (changes.length > 0) {
			const selectedCount = store.selectedChanges.length;
			const all = heading.createEl('input', { type: 'checkbox', attr: { 'aria-label': 'Select all changes' } });
			all.checked = selectedCount === changes.length;
			all.indeterminate = selectedCount > 0 && selectedCount < changes.length;
			all.addEventListener('change', () => store.setAllSelected(all.checked));
		}
		heading.createSpan({ text: changes.length ? `Changes (${changes.length})` : 'Changes' });

		if (changes.length === 0) {
			section.createDiv({ cls: 'my-git-empty', text: 'No changes to commit.' });
			return;
		}
		const list = section.createDiv({ cls: 'my-git-changes' });
		for (const change of changes) this.renderChange(list, change);
	}

	private renderChange(list: HTMLElement, change: Change): void {
		const { store } = this.sources;
		const row = list.createDiv({ cls: 'my-git-change' });
		const box = row.createEl('input', { type: 'checkbox', attr: { 'aria-label': `Include ${change.vaultPath}` } });
		box.checked = store.isSelected(change);
		box.addEventListener('change', () => store.setSelected(change, box.checked));
		row.createSpan({ cls: `my-git-kind my-git-kind-${change.kind}`, text: KIND_LETTER[change.kind], attr: { 'aria-label': KIND_LABEL[change.kind] } });

		const name = row.createEl('button', { cls: 'my-git-file', attr: { 'aria-label': change.fromVaultPath ? `${change.fromVaultPath} → ${change.vaultPath}` : change.vaultPath } });
		const { file, folder } = splitPath(change.vaultPath);
		name.createSpan({ cls: 'my-git-file-name', text: file });
		if (folder) name.createSpan({ cls: 'my-git-file-folder', text: folder });
		name.addEventListener('click', () => this.sources.openChange(change));

		const tools = row.createDiv({ cls: 'my-git-change-tools' });
		const diff = tools.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Show diff' } });
		setIcon(diff, 'file-diff');
		diff.addEventListener('click', () => this.sources.openChangeDiff(change));
		const discard = tools.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Discard changes' } });
		setIcon(discard, 'undo-2');
		discard.disabled = change.kind === 'conflicted' || store.busy !== null;
		discard.addEventListener('click', () => this.sources.discard(change));
	}

	private renderActions(): void {
		const { store } = this.sources;
		const snapshot = store.snapshot;
		const actions = this.actionsEl;
		actions.empty();
		const blocked = store.blockedReason !== null;
		const nothingSelected = store.selectedChanges.length === 0;

		const button = (text: string, operation: Operation, onClick: () => void, cta = false) => {
			const el = actions.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
			el.disabled = blocked || store.busy !== null;
			el.toggleClass('is-busy', store.busy === operation);
			el.addEventListener('click', onClick);
			return el;
		};
		const commit = button('Commit', 'commit', () => void this.commit(false), true);
		if (nothingSelected) commit.disabled = true;
		if (store.hasRemote) {
			const commitPush = button('Commit & push', 'commit-push', () => void this.commit(true));
			if (nothingSelected) commitPush.disabled = true;
			const behind = snapshot?.upstream ? (store.fetchFailed ? ' ↓?' : snapshot.behind ? ` ↓${snapshot.behind}` : '') : '';
			const pull = button(`Pull${behind}`, 'pull', () => void store.pull());
			if (!snapshot?.upstream) {
				pull.disabled = true;
				pull.setAttr('aria-label', 'No upstream yet; push once to set one');
			}
			const ahead = snapshot?.upstream && snapshot.ahead ? ` ↑${snapshot.ahead}` : '';
			button(`Push${ahead}`, 'push', () => void store.push());
		}
	}

	private async commit(push: boolean): Promise<void> {
		const { store } = this.sources;
		const committed = push ? await store.commitAndPush(this.message.value) : await store.commit(this.message.value);
		if (committed) this.message.value = '';
	}

	private renderHistory(): void {
		const { store } = this.sources;
		const root = this.historyEl;
		root.empty();
		if (store.history.length === 0) return;
		const details = root.createEl('details', { cls: 'my-git-section my-git-history' });
		details.open = this.historyOpen;
		details.addEventListener('toggle', () => (this.historyOpen = details.open));
		details.createEl('summary', { cls: 'my-git-section-heading', text: 'History' });

		const current = new Set(store.history.map((entry) => entry.hash));
		for (const hash of this.expanded.keys()) if (!current.has(hash)) this.expanded.delete(hash);

		for (const entry of store.history) {
			const item = details.createEl('details', { cls: 'my-git-commit' });
			item.open = this.expanded.has(entry.hash);
			const summary = item.createEl('summary');
			summary.createSpan({ cls: 'my-git-commit-subject', text: entry.subject });
			if (entry.unpushed) summary.createSpan({ cls: 'my-git-unpushed', text: '↑', attr: { 'aria-label': 'Not pushed yet' } });
			summary.createSpan({ cls: 'my-git-commit-meta', text: `${relativeTime(entry.time)} · ${entry.shortHash}` });
			const files = item.createDiv({ cls: 'my-git-commit-files' });
			item.addEventListener('toggle', () => {
				if (!item.open) {
					this.expanded.delete(entry.hash);
					return;
				}
				if (!this.expanded.has(entry.hash)) this.expanded.set(entry.hash, null);
				void this.loadCommitFiles(entry, files);
			});
			if (item.open) void this.loadCommitFiles(entry, files);
		}
	}

	private async loadCommitFiles(entry: HistoryEntry, container: HTMLElement): Promise<void> {
		let files = this.expanded.get(entry.hash) ?? null;
		if (!files) {
			container.setText('Loading…');
			try {
				files = (await this.sources.store.repository?.commitFiles(entry.hash)) ?? [];
			} catch (error) {
				container.setText(error instanceof Error ? error.message : String(error));
				return;
			}
			this.expanded.set(entry.hash, files);
		}
		container.empty();
		if (files.length === 0) container.createDiv({ cls: 'my-git-empty', text: 'No files in this vault changed.' });
		for (const change of files) {
			const row = container.createEl('button', { cls: 'my-git-file my-git-commit-file' });
			row.createSpan({ cls: `my-git-kind my-git-kind-${change.kind}`, text: KIND_LETTER[change.kind] });
			row.createSpan({ cls: 'my-git-file-name', text: change.vaultPath });
			row.addEventListener('click', () => this.sources.openCommitDiff(entry, change));
		}
	}
}

/** Splits "Folder/Sub/note.md" into the file name and its folder. */
function splitPath(path: string): { file: string; folder: string } {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? { file: path, folder: '' } : { file: path.slice(slash + 1), folder: path.slice(0, slash) };
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a date. */
function relativeTime(time: number): string {
	const minutes = Math.round((Date.now() - time) / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} d ago`;
	return new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
