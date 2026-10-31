import { debounce, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, setIcon, TFile, type App } from 'obsidian';
import { DIFF_VIEW_TYPE, DiffView, type DiffState } from './diff-view.ts';
import { Repository, type Change, type HistoryEntry, type RunIn } from './git/repository.ts';
import { gitRunner } from './git/run.ts';
import { CommitModal, DiscardModal } from './modals.ts';
import { GitStore, type Operation } from './store.ts';
import { GIT_VIEW_TYPE, GitView } from './view.ts';

interface MyGitSettings {
	/** The git binary's full path; empty looks `git` up on PATH. */
	gitPath: string;
	/** Minutes between background Fetches; 0 turns them off. */
	fetchMinutes: number;
	pullOnStartup: boolean;
}

const DEFAULT_SETTINGS: MyGitSettings = { gitPath: '', fetchMinutes: 10, pullOnStartup: false };

/** How long vault edits must pause before the change list refreshes. */
const REFRESH_DEBOUNCE_MS = 1000;

const BUSY_TEXT: Record<Operation, string> = {
	commit: 'committing…',
	'commit-push': 'committing…',
	pull: 'pulling…',
	push: 'pushing…',
	discard: 'discarding…',
	init: 'initializing…',
};

export default class MyGitPlugin extends Plugin {
	settings: MyGitSettings = { ...DEFAULT_SETTINGS };
	store!: GitStore;
	private fetchTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		const vaultPath = this.vaultPath();
		const runIn: RunIn = (cwd) => gitRunner(this.settings.gitPath.trim() || 'git', cwd);
		this.store = new GitStore({
			find: () => Repository.find(runIn, vaultPath),
			init: () => Repository.init(runIn, vaultPath, this.app.vault.configDir),
			trash: (path) => this.trash(path),
			notify: (message) => new Notice(message),
		});

		this.registerView(
			GIT_VIEW_TYPE,
			(leaf) =>
				new GitView(leaf, {
					store: this.store,
					openChange: (change) => void this.openChange(change),
					openChangeDiff: (change) => void this.openDiff({ change }),
					openCommitDiff: (entry, change) => void this.openCommitDiff(entry, change),
					discard: (change) => this.confirmDiscard(change),
				}),
		);
		this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, this.store));

		this.addRibbonIcon('git-branch', 'Open Git panel', () => void this.openPanel());
		this.addCommands();
		this.addSettingTab(new MyGitSettingTab(this.app, this));
		this.addStatusBar();

		const refresh = debounce(() => this.store.refreshIfIdle(), REFRESH_DEBOUNCE_MS, true);
		this.registerEvent(this.app.vault.on('create', refresh));
		this.registerEvent(this.app.vault.on('modify', refresh));
		this.registerEvent(this.app.vault.on('delete', refresh));
		this.registerEvent(this.app.vault.on('rename', refresh));
		// Catches commits and edits made in a terminal while Obsidian was in the background.
		this.registerDomEvent(window, 'focus', () => this.store.refreshIfIdle());

		this.app.workspace.onLayoutReady(() => void this.start());
	}

	onunload() {
		this.stopFetchTimer();
	}

	private async start(): Promise<void> {
		await this.store.refresh();
		if (this.settings.pullOnStartup && this.store.snapshot?.upstream && !this.store.blockedReason) await this.store.pull();
		else await this.store.fetch();
		this.restartFetchTimer();
	}

	private addCommands(): void {
		const { store } = this;
		const whenRemote = (run: () => void) => (checking: boolean) => {
			if (!store.hasRemote) return false;
			if (!checking) run();
			return true;
		};
		this.addCommand({ id: 'open-panel', name: 'Open Git panel', callback: () => void this.openPanel() });
		this.addCommand({ id: 'pull', name: 'Pull', checkCallback: whenRemote(() => void store.pull()) });
		this.addCommand({ id: 'push', name: 'Push', checkCallback: whenRemote(() => void store.push()) });
		this.addCommand({
			id: 'commit',
			name: 'Commit…',
			checkCallback: (checking) => {
				if (!store.snapshot) return false;
				if (!checking) this.openCommitModal();
				return true;
			},
		});
		this.addCommand({
			id: 'commit-and-push',
			name: 'Commit & push',
			checkCallback: whenRemote(() => this.openCommitModal()),
		});
	}

	private openCommitModal(): void {
		const { store } = this;
		if (store.busy) {
			new Notice('Git is busy. Try again in a moment.');
			return;
		}
		if (store.blockedReason) {
			new Notice(store.blockedReason);
			return;
		}
		if (store.selectedChanges.length === 0) {
			new Notice(store.changes.length === 0 ? 'No changes to commit.' : 'Select at least one change to commit.');
			return;
		}
		new CommitModal(this.app, store).open();
	}

	/** `⎇ main · 3 changed · ↑1 ↓2`, hidden outside a repository; clicking it opens the panel. */
	private addStatusBar(): void {
		const item = this.addStatusBarItem();
		item.addClass('my-git-status-bar', 'mod-clickable');
		item.setAttr('aria-label', 'Open Git panel');
		item.addEventListener('click', () => void this.openPanel());
		const update = () => {
			const { snapshot, busy, fetchFailed } = this.store;
			item.empty();
			item.toggle(snapshot !== null);
			if (!snapshot) return;
			setIcon(item.createSpan({ cls: 'my-git-status-icon' }), 'git-branch');
			const parts = [snapshot.branch ?? 'detached'];
			if (snapshot.changes.length > 0) parts.push(`${snapshot.changes.length} changed`);
			if (snapshot.upstream) {
				const counts = [snapshot.ahead ? `↑${snapshot.ahead}` : '', fetchFailed ? '↓?' : snapshot.behind ? `↓${snapshot.behind}` : ''].filter(Boolean);
				if (counts.length) parts.push(counts.join(' '));
			}
			if (busy) parts.push(BUSY_TEXT[busy]);
			item.createSpan({ text: parts.join(' · ') });
		};
		update();
		this.register(this.store.subscribe(update));
	}

	async openPanel(): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType(GIT_VIEW_TYPE)[0] ?? workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: GIT_VIEW_TYPE, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** Opens a file in the editor; deleted files and files outside the vault index open as a diff instead. */
	private async openChange(change: Change): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(change.vaultPath);
		if (change.kind === 'deleted' || !(file instanceof TFile)) {
			await this.openDiff({ change });
			return;
		}
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	private async openCommitDiff(entry: HistoryEntry, change: Change): Promise<void> {
		await this.openDiff({ change, commit: { hash: entry.hash, shortHash: entry.shortHash } });
	}

	/** Reuses an open diff tab, so browsing Changes does not pile up tabs. */
	private async openDiff(state: DiffState): Promise<void> {
		const { workspace } = this.app;
		const leaf = workspace.getLeavesOfType(DIFF_VIEW_TYPE)[0] ?? workspace.getLeaf('tab');
		await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true, state: { ...state } });
		await workspace.revealLeaf(leaf);
	}

	private confirmDiscard(change: Change): void {
		const neverCommitted = change.kind === 'untracked' || change.kind === 'added';
		new DiscardModal(this.app, change.vaultPath, neverCommitted, () => void this.store.discard(change)).open();
	}

	/** Uses the user's deletion setting for indexed files; dotfiles are outside the index, so go to system trash. */
	private async trash(vaultPath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (file) {
			await this.app.fileManager.trashFile(file);
			return;
		}
		const { adapter } = this.app.vault;
		if (!(await adapter.trashSystem(vaultPath))) await adapter.trashLocal(vaultPath);
	}

	private vaultPath(): string {
		const { adapter } = this.app.vault;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error('My Git needs the desktop app.');
		return adapter.getBasePath();
	}

	restartFetchTimer(): void {
		this.stopFetchTimer();
		const minutes = this.settings.fetchMinutes;
		if (!(minutes > 0)) return;
		this.fetchTimer = window.setInterval(() => void this.store.fetch(), minutes * 60 * 1000);
	}

	private stopFetchTimer(): void {
		if (this.fetchTimer !== null) window.clearInterval(this.fetchTimer);
		this.fetchTimer = null;
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<MyGitSettings> | null) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class MyGitSettingTab extends PluginSettingTab {
	private readonly plugin: MyGitPlugin;

	constructor(app: App, plugin: MyGitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl, plugin } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Git path')
			.setDesc('Full path to the Git program. Leave empty to find it automatically; fill it in only if Obsidian cannot find Git.')
			.addText((text) =>
				text
					.setPlaceholder('Found automatically')
					.setValue(plugin.settings.gitPath)
					.onChange(async (value) => {
						plugin.settings.gitPath = value.trim();
						await plugin.saveSettings();
						void plugin.store.refresh();
					}),
			);

		new Setting(containerEl)
			.setName('Background fetch interval')
			.setDesc('Minutes between checks for new commits on the remote. Set to 0 to turn off.')
			.addText((text) =>
				text
					.setPlaceholder('10')
					.setValue(String(plugin.settings.fetchMinutes))
					.onChange(async (value) => {
						const minutes = Number(value);
						if (!Number.isFinite(minutes) || minutes < 0) return;
						plugin.settings.fetchMinutes = minutes;
						await plugin.saveSettings();
						plugin.restartFetchTimer();
					}),
			);

		new Setting(containerEl)
			.setName('Pull on startup')
			.setDesc('Pull when Obsidian opens this vault, if the branch has an upstream.')
			.addToggle((toggle) =>
				toggle.setValue(plugin.settings.pullOnStartup).onChange(async (value) => {
					plugin.settings.pullOnStartup = value;
					await plugin.saveSettings();
				}),
			);
	}
}
