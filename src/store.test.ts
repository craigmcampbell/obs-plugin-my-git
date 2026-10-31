import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRunner } from './git/run.ts';
import { Repository, type RunIn } from './git/repository.ts';
import { defaultMessage, GitStore } from './store.ts';

const runIn: RunIn = (cwd) => gitRunner('git', cwd);

/** A store over a fresh repository in a temp folder, collecting its notices. */
async function setup(t: { after: (fn: () => void) => void }): Promise<{ dir: string; store: GitStore; notices: string[] }> {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'my-git-store-')));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const notices: string[] = [];
	const store = new GitStore({
		find: () => Repository.find(runIn, dir),
		init: async () => {
			const repository = await Repository.init(runIn, dir, '.obsidian');
			const run = runIn(dir);
			await run(['config', 'user.name', 'Test']);
			await run(['config', 'user.email', 'test@example.com']);
			await run(['config', 'commit.gpgsign', 'false']);
			return repository;
		},
		trash: async (path) => rmSync(join(dir, path)),
		notify: (message) => notices.push(message),
	});
	return { dir, store, notices };
}

test('defaultMessage is a dated vault update', () => {
	assert.equal(defaultMessage(new Date(2026, 9, 31, 9, 5)), 'Vault update 2026-10-31 09:05');
});

test('a vault outside any repository loads with no snapshot, and init creates one', async (t) => {
	const { store, notices } = await setup(t);
	await store.refresh();
	assert.equal(store.loaded, true);
	assert.equal(store.repository, null);
	await store.init();
	assert.ok(store.snapshot);
	assert.deepEqual(
		store.changes.map((c) => c.vaultPath),
		['.gitignore'],
	);
	assert.deepEqual(notices, ['Initialized a git repository in this vault.']);
});

test('unticked Changes stay unticked across refreshes, and are ticked again after leaving the list', async (t) => {
	const { dir, store } = await setup(t);
	await store.init();
	writeFileSync(join(dir, 'a.md'), 'a');
	writeFileSync(join(dir, 'b.md'), 'b');
	await store.refresh();
	const b = store.changes.find((c) => c.vaultPath === 'b.md');
	assert.ok(b);
	store.setSelected(b, false);
	await store.refresh();
	assert.deepEqual(
		store.selectedChanges.map((c) => c.vaultPath),
		['.gitignore', 'a.md'],
	);

	rmSync(join(dir, 'b.md'));
	await store.refresh();
	writeFileSync(join(dir, 'b.md'), 'back');
	await store.refresh();
	assert.deepEqual(
		store.selectedChanges.map((c) => c.vaultPath),
		['.gitignore', 'a.md', 'b.md'],
	);
});

test('commit uses the default message when left empty and commits only ticked Changes', async (t) => {
	const { dir, store, notices } = await setup(t);
	await store.init();
	writeFileSync(join(dir, 'a.md'), 'a');
	await store.refresh();
	const gitignore = store.changes.find((c) => c.vaultPath === '.gitignore');
	assert.ok(gitignore);
	store.setSelected(gitignore, false);
	assert.equal(await store.commit('  '), true);
	assert.match(notices.at(-1) ?? '', /^Committed 1 file \([0-9a-f]+\)\.$/);
	assert.match(store.history[0]?.subject ?? '', /^Vault update \d{4}-\d\d-\d\d \d\d:\d\d$/);
	assert.deepEqual(
		store.changes.map((c) => c.vaultPath),
		['.gitignore'],
	);
});

test('a second operation while one runs is refused as busy', async (t) => {
	const { dir, store, notices } = await setup(t);
	await store.init();
	writeFileSync(join(dir, 'a.md'), 'a');
	await store.refresh();
	const first = store.commit('First');
	assert.equal(store.busy, 'commit');
	await store.commit('Second');
	await first;
	assert.ok(notices.includes('Git is busy. Try again in a moment.'));
	assert.equal(store.history.length, 1);
});

test('nothing selected means nothing committed', async (t) => {
	const { store, notices } = await setup(t);
	await store.init();
	store.setAllSelected(false);
	assert.equal(await store.commit('Nothing'), false);
	assert.equal(notices.at(-1), 'Select at least one change to commit.');
});

test('pull without an upstream says so instead of running', async (t) => {
	const { store, notices } = await setup(t);
	await store.init();
	await store.commit('First');
	await store.pull();
	assert.equal(notices.at(-1), 'This branch has no upstream yet. Push it once to set one.');
});
