import { Modal, type App } from 'obsidian';
import { defaultMessage, type GitStore } from './store.ts';

/** Asks before Discarding a Change, naming the file and what will happen to it. */
export class DiscardModal extends Modal {
	private readonly path: string;
	private readonly neverCommitted: boolean;
	private readonly onConfirm: () => void;

	constructor(app: App, path: string, neverCommitted: boolean, onConfirm: () => void) {
		super(app);
		this.path = path;
		this.neverCommitted = neverCommitted;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.setTitle('Discard changes?');
		this.contentEl.createEl('p', {
			text: this.neverCommitted
				? `${this.path} has never been committed, so it will be moved to the trash.`
				: `${this.path} will go back to its last committed version. Your edits will be lost.`,
		});
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const discard = buttons.createEl('button', { cls: 'mod-warning', text: 'Discard' });
		discard.addEventListener('click', () => {
			this.close();
			this.onConfirm();
		});
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** The Commit… command: a message box that commits the ticked Changes, optionally pushing too. */
export class CommitModal extends Modal {
	private readonly store: GitStore;

	constructor(app: App, store: GitStore) {
		super(app);
		this.store = store;
	}

	onOpen(): void {
		const { store } = this;
		const count = store.selectedChanges.length;
		this.setTitle(`Commit ${count} ${count === 1 ? 'change' : 'changes'}`);
		const message = this.contentEl.createEl('textarea', {
			cls: 'my-git-message',
			attr: { rows: '4', placeholder: defaultMessage(new Date()), 'aria-label': 'Commit message' },
		});
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const submit = async (push: boolean) => {
			this.close();
			if (push) await store.commitAndPush(message.value);
			else await store.commit(message.value);
		};
		message.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void submit(false);
			}
		});
		if (store.hasRemote) buttons.createEl('button', { text: 'Commit & push' }).addEventListener('click', () => void submit(true));
		buttons.createEl('button', { cls: 'mod-cta', text: 'Commit' }).addEventListener('click', () => void submit(false));
		window.setTimeout(() => message.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
