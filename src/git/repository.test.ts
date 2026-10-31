import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitRunner } from './run.ts';
import { PushRejectedError, Repository, starterGitignore, type RunIn } from './repository.ts';

const runIn: RunIn = (cwd) => gitRunner('git', cwd);

function tempDir(t: { after: (fn: () => void) => void }): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'my-git-')));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await runIn(cwd)(args)).stdout.trim();
}

/** A repository with a committer identity, so commits work on machines without a global one. */
async function makeRepo(dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	await git(dir, 'init', '--quiet', '--initial-branch=main');
	await git(dir, 'config', 'user.name', 'Test');
	await git(dir, 'config', 'user.email', 'test@example.com');
	await git(dir, 'config', 'commit.gpgsign', 'false');
}

function write(dir: string, path: string, text: string): void {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), text);
}

async function open(dir: string): Promise<Repository> {
	const repository = await Repository.find(runIn, dir);
	assert.ok(repository);
	return repository;
}

/** A bare Remote with one commit, and a clone of it. */
async function cloned(t: { after: (fn: () => void) => void }): Promise<{ remote: string; vault: string }> {
	const root = tempDir(t);
	const remote = join(root, 'remote.git');
	const seed = join(root, 'seed');
	await git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
	await makeRepo(seed);
	write(seed, 'note.md', 'one\ntwo\nthree\n');
	await git(seed, 'add', '.');
	await git(seed, 'commit', '--quiet', '-m', 'Seed');
	await git(seed, 'remote', 'add', 'origin', remote);
	await git(seed, 'push', '--quiet', '-u', 'origin', 'main');
	const vault = join(root, 'vault');
	await git(root, 'clone', '--quiet', remote, vault);
	await git(vault, 'config', 'user.name', 'Test');
	await git(vault, 'config', 'user.email', 'test@example.com');
	return { remote, vault };
}

test('find returns null outside a repository', async (t) => {
	assert.equal(await Repository.find(runIn, tempDir(t)), null);
});

test('init creates a repository and a starter .gitignore, but keeps an existing one', async (t) => {
	const fresh = tempDir(t);
	await Repository.init(runIn, fresh, '.obsidian');
	assert.equal(readFileSync(join(fresh, '.gitignore'), 'utf8'), starterGitignore('.obsidian'));

	const kept = tempDir(t);
	write(kept, '.gitignore', 'mine\n');
	const repository = await Repository.init(runIn, kept, '.obsidian');
	assert.equal(readFileSync(join(kept, '.gitignore'), 'utf8'), 'mine\n');
	assert.equal((await repository.snapshot()).hasCommits, false);
});

test('snapshot lists only Changes inside a vault that is a subfolder of the repository', async (t) => {
	const root = tempDir(t);
	await makeRepo(root);
	write(root, 'outside.md', 'x');
	write(root, 'Vaults/Work/inside.md', 'x');
	const vault = join(root, 'Vaults/Work');
	const snapshot = await (await open(vault)).snapshot();
	assert.deepEqual(
		snapshot.changes.map((c) => [c.kind, c.path, c.vaultPath]),
		[['untracked', 'Vaults/Work/inside.md', 'inside.md']],
	);
	assert.equal(snapshot.branch, 'main');
	assert.equal(snapshot.hasCommits, false);
	assert.deepEqual(snapshot.remotes, []);
});

test('commit records only the selected Changes and leaves other staged files staged', async (t) => {
	const dir = tempDir(t);
	await makeRepo(dir);
	write(dir, 'a.md', 'a');
	write(dir, 'b.md', 'b');
	write(dir, 'c.md', 'c');
	await git(dir, 'add', 'c.md');
	const repository = await open(dir);
	const { changes } = await repository.snapshot();
	await repository.commit(
		changes.filter((c) => c.path === 'a.md'),
		'Add a',
	);
	assert.equal(await git(dir, 'log', '--format=%s'), 'Add a');
	assert.equal(await git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'a.md');
	const after = await repository.snapshot();
	assert.deepEqual(
		after.changes.map((c) => [c.kind, c.path]),
		[
			['untracked', 'b.md'],
			['added', 'c.md'],
		],
	);
});

test('commit handles deletions and staged renames', async (t) => {
	const dir = tempDir(t);
	await makeRepo(dir);
	write(dir, 'old.md', 'keep me');
	write(dir, 'drop.md', 'bye');
	await git(dir, 'add', '.');
	await git(dir, 'commit', '--quiet', '-m', 'Start');
	await git(dir, 'mv', 'old.md', 'new.md');
	rmSync(join(dir, 'drop.md'));
	const repository = await open(dir);
	const { changes } = await repository.snapshot();
	assert.deepEqual(
		changes.map((c) => [c.kind, c.path, c.fromPath]),
		[
			['deleted', 'drop.md', undefined],
			['renamed', 'new.md', 'old.md'],
		],
	);
	await repository.commit(changes, 'Tidy');
	assert.equal((await repository.snapshot()).changes.length, 0);
	assert.equal(await git(dir, 'ls-files'), 'new.md');
});

test('discard restores tracked files and trashes new ones', async (t) => {
	const dir = tempDir(t);
	await makeRepo(dir);
	write(dir, 'note.md', 'original');
	await git(dir, 'add', '.');
	await git(dir, 'commit', '--quiet', '-m', 'Start');
	write(dir, 'note.md', 'edited');
	write(dir, 'scratch.md', 'new');
	write(dir, 'staged.md', 'new');
	await git(dir, 'add', 'staged.md');
	const repository = await open(dir);
	const snapshot = await repository.snapshot();
	const trashed: string[] = [];
	const trash = async (path: string) => {
		trashed.push(path);
		rmSync(join(dir, path));
	};
	for (const change of snapshot.changes) await repository.discard(change, snapshot, trash);
	assert.equal(readFileSync(join(dir, 'note.md'), 'utf8'), 'original');
	assert.deepEqual(trashed.sort(), ['scratch.md', 'staged.md']);
	assert.equal((await repository.snapshot()).changes.length, 0);
});

test('changeDiff shows edits against HEAD and new files in full', async (t) => {
	const dir = tempDir(t);
	await makeRepo(dir);
	write(dir, 'note.md', 'one\ntwo\n');
	await git(dir, 'add', '.');
	await git(dir, 'commit', '--quiet', '-m', 'Start');
	write(dir, 'note.md', 'one\n2\n');
	write(dir, 'fresh.md', 'hello\n');
	const repository = await open(dir);
	const snapshot = await repository.snapshot();
	const [fresh, note] = snapshot.changes;
	assert.ok(fresh && note);
	const edited = await repository.changeDiff(note, snapshot);
	assert.deepEqual(
		edited.lines.filter((l) => l.type === 'add' || l.type === 'del'),
		[
			{ type: 'del', text: 'two' },
			{ type: 'add', text: '2' },
		],
	);
	const added = await repository.changeDiff(fresh, snapshot);
	assert.deepEqual(
		added.lines.filter((l) => l.type === 'add'),
		[{ type: 'add', text: 'hello' }],
	);
});

test('history marks unpushed commits, and commitFiles and commitDiff describe one', async (t) => {
	const { vault } = await cloned(t);
	write(vault, 'note.md', 'one\ntwo\nthree\nfour\n');
	const repository = await open(vault);
	await repository.commit((await repository.snapshot()).changes, 'Add four');
	const snapshot = await repository.snapshot();
	assert.equal(snapshot.ahead, 1);
	const history = await repository.history(snapshot);
	assert.deepEqual(
		history.map((h) => [h.subject, h.unpushed]),
		[
			['Add four', true],
			['Seed', false],
		],
	);
	const [latest] = history;
	assert.ok(latest);
	const files = await repository.commitFiles(latest.hash);
	assert.deepEqual(
		files.map((f) => [f.kind, f.vaultPath]),
		[['modified', 'note.md']],
	);
	const [file] = files;
	assert.ok(file);
	const diff = await repository.commitDiff(latest.hash, file);
	assert.deepEqual(
		diff.lines.filter((l) => l.type === 'add'),
		[{ type: 'add', text: 'four' }],
	);
});

test('push sets the upstream on a branch that has none', async (t) => {
	const { remote, vault } = await cloned(t);
	await git(vault, 'switch', '--quiet', '-c', 'drafts');
	write(vault, 'draft.md', 'x');
	const repository = await open(vault);
	await repository.commit((await repository.snapshot()).changes, 'Draft');
	await repository.push(await repository.snapshot());
	assert.equal((await repository.snapshot()).upstream, 'origin/drafts');
	assert.equal(await git(remote, 'log', '--format=%s', 'drafts', '-n1'), 'Draft');
});

test('push is rejected when the remote is ahead, and pull rebases with uncommitted edits set aside', async (t) => {
	const { remote, vault } = await cloned(t);
	const other = join(dirname(vault), 'other');
	await git(dirname(vault), 'clone', '--quiet', remote, other);
	await git(other, 'config', 'user.name', 'Other');
	await git(other, 'config', 'user.email', 'other@example.com');
	write(other, 'theirs.md', 'from elsewhere');
	await git(other, 'add', '.');
	await git(other, 'commit', '--quiet', '-m', 'Theirs');
	await git(other, 'push', '--quiet');

	const repository = await open(vault);
	write(vault, 'mine.md', 'committed');
	await repository.commit((await repository.snapshot()).changes, 'Mine');
	await assert.rejects(repository.push(await repository.snapshot()), PushRejectedError);

	write(vault, 'note.md', 'one\ntwo\nthree\nuncommitted\n');
	assert.deepEqual(await repository.pull(), { kind: 'pulled', commits: 1 });
	assert.equal(await git(vault, 'log', '--format=%s'), 'Mine\nTheirs\nSeed');
	assert.equal(readFileSync(join(vault, 'note.md'), 'utf8'), 'one\ntwo\nthree\nuncommitted\n');
	await repository.push(await repository.snapshot());
	assert.equal((await repository.snapshot()).ahead, 0);
});

test('pull undoes itself on a Conflict and names the files', async (t) => {
	const { remote, vault } = await cloned(t);
	const other = join(dirname(vault), 'other');
	await git(dirname(vault), 'clone', '--quiet', remote, other);
	await git(other, 'config', 'user.name', 'Other');
	await git(other, 'config', 'user.email', 'other@example.com');
	write(other, 'note.md', 'one\nTHEIRS\nthree\n');
	await git(other, 'commit', '--quiet', '-am', 'Theirs');
	await git(other, 'push', '--quiet');

	const repository = await open(vault);
	write(vault, 'note.md', 'one\nMINE\nthree\n');
	await repository.commit((await repository.snapshot()).changes, 'Mine');
	assert.deepEqual(await repository.pull(), { kind: 'conflict', paths: ['note.md'] });
	const snapshot = await repository.snapshot();
	assert.equal(snapshot.unfinished, null);
	assert.equal(readFileSync(join(vault, 'note.md'), 'utf8'), 'one\nMINE\nthree\n');
	assert.equal(existsSync(join(vault, '.git', 'rebase-merge')), false);
});

test('snapshot reports an unfinished merge', async (t) => {
	const dir = tempDir(t);
	await makeRepo(dir);
	write(dir, 'n.md', 'base\n');
	await git(dir, 'add', '.');
	await git(dir, 'commit', '--quiet', '-m', 'Base');
	await git(dir, 'switch', '--quiet', '-c', 'side');
	write(dir, 'n.md', 'side\n');
	await git(dir, 'commit', '--quiet', '-am', 'Side');
	await git(dir, 'switch', '--quiet', 'main');
	write(dir, 'n.md', 'main\n');
	await git(dir, 'commit', '--quiet', '-am', 'Main');
	await runIn(dir)(['merge', 'side'], { okCodes: [0, 1] });
	const snapshot = await (await open(dir)).snapshot();
	assert.equal(snapshot.unfinished, 'merge');
	assert.deepEqual(
		snapshot.changes.map((c) => c.kind),
		['conflicted'],
	);
});
