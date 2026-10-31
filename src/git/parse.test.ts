import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, parseLog, parseNameStatus, parseStatus } from './parse.ts';

test('parseStatus reads the branch headers and every kind of entry', () => {
	const output = [
		'# branch.oid 1234abcd',
		'# branch.head main',
		'# branch.upstream origin/main',
		'# branch.ab +2 -1',
		'1 .M N... 100644 100644 100644 aaa bbb Notes/My note.md',
		'1 A. N... 000000 100644 100644 000 bbb new.md',
		'1 .D N... 100644 100644 000000 aaa aaa gone.md',
		'2 R. N... 100644 100644 100644 aaa aaa R100 Archive/moved.md',
		'Inbox/moved.md',
		'u UU N... 100644 100644 100644 100644 a b c clash.md',
		'? Draft with spaces.md',
		'',
	].join('\0');
	assert.deepEqual(parseStatus(output), {
		branch: 'main',
		hasCommits: true,
		upstream: 'origin/main',
		ahead: 2,
		behind: 1,
		entries: [
			{ kind: 'modified', path: 'Notes/My note.md' },
			{ kind: 'added', path: 'new.md' },
			{ kind: 'deleted', path: 'gone.md' },
			{ kind: 'renamed', path: 'Archive/moved.md', fromPath: 'Inbox/moved.md' },
			{ kind: 'conflicted', path: 'clash.md' },
			{ kind: 'untracked', path: 'Draft with spaces.md' },
		],
	});
});

test('parseStatus spots a detached HEAD and a repository with no commits', () => {
	assert.equal(parseStatus('# branch.oid abc\0# branch.head (detached)\0').branch, null);
	const fresh = parseStatus('# branch.oid (initial)\0# branch.head main\0');
	assert.equal(fresh.hasCommits, false);
	assert.equal(fresh.upstream, null);
});

test('parseLog splits records and converts seconds to milliseconds', () => {
	const output = 'abc123\x1fabc\x1fFirst: with colon\x1f1700000000\x1e\ndef456\x1fdef\x1fSecond\x1f1700000100\x1e\n';
	assert.deepEqual(parseLog(output), [
		{ hash: 'abc123', shortHash: 'abc', subject: 'First: with colon', time: 1700000000000 },
		{ hash: 'def456', shortHash: 'def', subject: 'Second', time: 1700000100000 },
	]);
});

test('parseNameStatus handles renames, which carry two paths', () => {
	const output = ['M', 'a.md', 'R092', 'old.md', 'new.md', 'D', 'b.md', 'A', 'c.md', ''].join('\0');
	assert.deepEqual(parseNameStatus(output), [
		{ kind: 'modified', path: 'a.md' },
		{ kind: 'renamed', path: 'new.md', fromPath: 'old.md' },
		{ kind: 'deleted', path: 'b.md' },
		{ kind: 'added', path: 'c.md' },
	]);
});

test('parseDiff keeps hunks and lines and drops file headers', () => {
	const output = [
		'diff --git a/n.md b/n.md',
		'index 1..2 100644',
		'--- a/n.md',
		'+++ b/n.md',
		'@@ -1,2 +1,2 @@',
		' same',
		'-old',
		'+new',
		'\\ No newline at end of file',
	].join('\n');
	assert.deepEqual(parseDiff(output), {
		binary: false,
		lines: [
			{ type: 'hunk', text: '@@ -1,2 +1,2 @@' },
			{ type: 'context', text: 'same' },
			{ type: 'del', text: 'old' },
			{ type: 'add', text: 'new' },
			{ type: 'note', text: 'No newline at end of file' },
		],
	});
});

test('parseDiff flags binary files', () => {
	const output = 'diff --git a/p.png b/p.png\nindex 1..2\nBinary files a/p.png and b/p.png differ\n';
	assert.deepEqual(parseDiff(output), { binary: true, lines: [] });
});
