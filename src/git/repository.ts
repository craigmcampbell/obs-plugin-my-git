import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError, type Run } from './run.ts';
import { LOG_FORMAT, parseDiff, parseLog, parseNameStatus, parseStatus, type BranchStatus, type Diff, type LogEntry, type StatusEntry } from './parse.ts';

/** git's id for the tree with no files, used as the base before the first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Written by Initialize repository; an existing `.gitignore` is never touched. */
export function starterGitignore(configDir: string): string {
	return [`${configDir}/workspace*.json`, '.trash/', '.DS_Store', ''].join('\n');
}

/** An operation left unfinished, usually from a terminal, during which Commit, Pull and Push are disabled. */
export type UnfinishedState = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'detached';

/** A Change, with its path both from the repository root (for git) and from the vault root (for Obsidian). */
export interface Change extends StatusEntry {
	vaultPath: string;
	fromVaultPath?: string;
}

export interface Snapshot extends BranchStatus {
	remotes: string[];
	unfinished: UnfinishedState | null;
	changes: Change[];
}

export interface HistoryEntry extends LogEntry {
	/** Not yet on any Remote. */
	unpushed: boolean;
}

export type PullResult = { kind: 'pulled'; commits: number } | { kind: 'conflict'; paths: string[] };

/** Push was refused because the Remote has commits this branch lacks. */
export class PushRejectedError extends Error {
	constructor() {
		super('The remote has new commits. Pull first, then push.');
	}
}

/** Makes a Run bound to a working directory. */
export type RunIn = (cwd: string) => Run;

/** The Repository that contains a vault, limited to the Changes inside the vault's folder. */
export class Repository {
	private readonly run: Run;
	/** The vault folder relative to the repository root, with a trailing slash, or '' when they are the same. */
	private readonly prefix: string;
	private readonly gitDir: string;

	private constructor(run: Run, prefix: string, gitDir: string) {
		this.run = run;
		this.prefix = prefix;
		this.gitDir = gitDir;
	}

	/** The Repository containing `vaultPath`, or null when the vault is not inside one. */
	static async find(runIn: RunIn, vaultPath: string): Promise<Repository | null> {
		let output: string;
		try {
			output = (await runIn(vaultPath)(['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir'])).stdout;
		} catch (error) {
			if (error instanceof GitError) return null;
			throw error;
		}
		const [root = '', prefix = '', gitDir = ''] = output.split('\n');
		return new Repository(runIn(root), prefix, gitDir);
	}

	/** Runs `git init` in the vault and writes a starter `.gitignore` if the vault has none. */
	static async init(runIn: RunIn, vaultPath: string, configDir: string): Promise<Repository> {
		await runIn(vaultPath)(['init']);
		try {
			await writeFile(join(vaultPath, '.gitignore'), starterGitignore(configDir), { flag: 'wx' });
		} catch {
			// One already exists.
		}
		const repository = await Repository.find(runIn, vaultPath);
		if (!repository) throw new Error('git init did not create a repository.');
		return repository;
	}

	async snapshot(): Promise<Snapshot> {
		const [status, remotes] = await Promise.all([
			this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', ...this.vaultPathspec()]),
			this.run(['remote']),
		]);
		const parsed = parseStatus(status.stdout);
		const changes = parsed.entries
			.filter((entry) => entry.path.startsWith(this.prefix))
			.map((entry) => this.withVaultPaths(entry))
			.sort((a, b) => a.vaultPath.localeCompare(b.vaultPath));
		return {
			...parsed,
			remotes: remotes.stdout.split('\n').filter(Boolean),
			unfinished: this.unfinished(parsed.branch),
			changes,
		};
	}

	/** The last `count` commits touching the vault, each marked if no Remote has it yet. */
	async history(snapshot: Snapshot, count = 20): Promise<HistoryEntry[]> {
		if (!snapshot.hasCommits) return [];
		const log = parseLog((await this.run(['log', `-n${count}`, `--format=${LOG_FORMAT}`, ...this.vaultPathspec()])).stdout);
		let unpushed: (hash: string) => boolean = () => false;
		if (snapshot.upstream) {
			const ahead = new Set((await this.run(['rev-list', '@{upstream}..HEAD'])).stdout.split('\n'));
			unpushed = (hash) => ahead.has(hash);
		} else if (snapshot.remotes.length > 0) {
			unpushed = () => true;
		}
		return log.map((entry) => ({ ...entry, unpushed: unpushed(entry.hash) }));
	}

	/** The vault files one commit changed, compared with its first parent. */
	async commitFiles(hash: string): Promise<Change[]> {
		const output = await this.run(['show', '--format=', '--name-status', '-z', '-M', '--diff-merges=first-parent', hash, ...this.vaultPathspec()]);
		return parseNameStatus(output.stdout)
			.filter((entry) => entry.path.startsWith(this.prefix))
			.map((entry) => this.withVaultPaths(entry));
	}

	/** Commits exactly `changes`, whatever else is staged, and returns the new commit's short hash. */
	async commit(changes: Change[], message: string): Promise<string> {
		const paths = changes.flatMap((change) => this.pathsOf(change));
		const pathspec = paths.join('\0');
		const fromStdin = ['--pathspec-from-file=-', '--pathspec-file-nul'];
		// git add refuses a path that is in neither the index nor the working tree, such as a staged deletion.
		const listed = await this.run(['ls-files', '--cached', '--others', '--exclude-standard', '-z', ...this.vaultPathspec()]);
		const known = new Set(listed.stdout.split('\0'));
		const toAdd = paths.filter((path) => known.has(path));
		if (toAdd.length > 0) await this.run(['add', '--all', ...fromStdin], { stdin: toAdd.join('\0') });
		await this.run(['commit', '--only', '--quiet', `--message=${message}`, ...fromStdin], { stdin: pathspec });
		return (await this.run(['rev-parse', '--short', 'HEAD'])).stdout.trim();
	}

	/** Rebases onto the Upstream, setting uncommitted edits aside meanwhile; on a Conflict, undoes the pull. */
	async pull(): Promise<PullResult> {
		const before = (await this.run(['rev-parse', '@{upstream}'])).stdout.trim();
		try {
			await this.run(['pull', '--rebase', '--autostash']);
		} catch (error) {
			if (!(error instanceof GitError) || this.unfinished('') !== 'rebase') throw error;
			const conflicted = await this.run(['diff', '--name-only', '--diff-filter=U', '-z']);
			await this.run(['rebase', '--abort']);
			const paths = conflicted.stdout.split('\0').filter(Boolean).map((path) => this.toVaultPath(path));
			return { kind: 'conflict', paths };
		}
		const count = await this.run(['rev-list', '--count', `${before}..@{upstream}`]);
		return { kind: 'pulled', commits: Number(count.stdout.trim()) };
	}

	/** Pushes to the Upstream, setting one first when the branch has none and there is a single Remote. */
	async push(snapshot: Snapshot): Promise<void> {
		let args = ['push', '--porcelain'];
		if (!snapshot.upstream) {
			const [remote, ...others] = snapshot.remotes;
			if (!remote) throw new Error('This repository has no remote to push to.');
			if (others.length > 0) throw new Error('This branch has no upstream and there are several remotes. Set one in a terminal with git push -u.');
			args = ['push', '--porcelain', '--set-upstream', remote, 'HEAD'];
		}
		try {
			await this.run(args);
		} catch (error) {
			if (error instanceof GitError && /\[rejected\]|non-fast-forward|fetch first/.test(error.result.stderr + error.result.stdout)) {
				throw new PushRejectedError();
			}
			throw error;
		}
	}

	/** Updates what is known about the Upstream, for the Ahead / Behind counts. */
	async fetch(): Promise<void> {
		await this.run(['fetch', '--quiet']);
	}

	/**
	 * Throws a Change away: tracked files go back to their committed version, and files that were never
	 * committed are passed to `trash` by vault path.
	 */
	async discard(change: Change, snapshot: Snapshot, trash: (vaultPath: string) => Promise<void>): Promise<void> {
		switch (change.kind) {
			case 'conflicted':
				throw new Error('Resolve conflicted files in a terminal.');
			case 'untracked':
				await trash(change.vaultPath);
				return;
			case 'added':
				await this.run(['rm', '--cached', '--quiet', '--', change.path]);
				await trash(change.vaultPath);
				return;
			case 'renamed':
				await this.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', change.fromPath ?? '']);
				await this.run(['rm', '--cached', '--quiet', '--', change.path]);
				await trash(change.vaultPath);
				return;
			case 'modified':
			case 'deleted':
				if (!snapshot.hasCommits) throw new Error('Nothing has been committed yet.');
				await this.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', change.path]);
		}
	}

	/** How `change` differs from the last commit. */
	async changeDiff(change: Change, snapshot: Snapshot): Promise<Diff> {
		const options = ['--no-color', '--no-ext-diff', '-M'];
		if (change.kind === 'untracked') {
			// --no-index exits 1 when the files differ, which they always do here.
			return parseDiff((await this.run(['diff', ...options, '--no-index', '--', '/dev/null', change.path], { okCodes: [0, 1] })).stdout);
		}
		const base = snapshot.hasCommits ? 'HEAD' : EMPTY_TREE;
		return parseDiff((await this.run(['diff', ...options, base, '--', ...this.pathsOf(change)])).stdout);
	}

	/** What one commit did to one file. */
	async commitDiff(hash: string, change: Change): Promise<Diff> {
		const args = ['show', '--format=', '--no-color', '--no-ext-diff', '-M', '--diff-merges=first-parent', hash, '--', ...this.pathsOf(change)];
		return parseDiff((await this.run(args)).stdout);
	}

	private pathsOf(change: StatusEntry): string[] {
		return change.fromPath ? [change.fromPath, change.path] : [change.path];
	}

	private vaultPathspec(): string[] {
		return this.prefix ? ['--', this.prefix] : [];
	}

	private withVaultPaths(entry: StatusEntry): Change {
		const change: Change = { ...entry, vaultPath: this.toVaultPath(entry.path) };
		if (entry.fromPath) change.fromVaultPath = this.toVaultPath(entry.fromPath);
		return change;
	}

	/** Paths outside the vault keep their repository path, which only happens for a rename's source. */
	private toVaultPath(path: string): string {
		return path.startsWith(this.prefix) ? path.slice(this.prefix.length) : path;
	}

	/** `branch` is null on a detached HEAD; pass '' to check only for an operation in progress. */
	private unfinished(branch: string | null): UnfinishedState | null {
		const has = (name: string) => existsSync(join(this.gitDir, name));
		if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
		if (has('MERGE_HEAD')) return 'merge';
		if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
		if (has('REVERT_HEAD')) return 'revert';
		return branch === null ? 'detached' : null;
	}
}
