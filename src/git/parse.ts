/** Parsers for git's machine-readable output. Every path here is relative to the repository root. */

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface StatusEntry {
	kind: ChangeKind;
	path: string;
	/** The path before a rename. */
	fromPath?: string;
}

export interface BranchStatus {
	/** The branch name, or null on a detached HEAD. */
	branch: string | null;
	/** False until the first commit. */
	hasCommits: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
}

export interface Status extends BranchStatus {
	entries: StatusEntry[];
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatus(output: string): Status {
	const status: Status = { branch: null, hasCommits: true, upstream: null, ahead: 0, behind: 0, entries: [] };
	const records = output.split('\0');
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? '';
		if (record.startsWith('# ')) {
			const [key = '', ...rest] = record.slice(2).split(' ');
			const value = rest.join(' ');
			if (key === 'branch.oid') status.hasCommits = value !== '(initial)';
			else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value;
			else if (key === 'branch.upstream') status.upstream = value;
			else if (key === 'branch.ab') {
				const match = /^\+(\d+) -(\d+)$/.exec(value);
				status.ahead = Number(match?.[1] ?? 0);
				status.behind = Number(match?.[2] ?? 0);
			}
		} else if (record.startsWith('1 ')) {
			const fields = splitFields(record, 9);
			const xy = fields[1] ?? '..';
			status.entries.push({ kind: ordinaryKind(xy), path: fields[8] ?? '' });
		} else if (record.startsWith('2 ')) {
			const fields = splitFields(record, 10);
			// With -z the original path follows as its own record.
			status.entries.push({ kind: 'renamed', path: fields[9] ?? '', fromPath: records[++i] ?? '' });
		} else if (record.startsWith('u ')) {
			status.entries.push({ kind: 'conflicted', path: splitFields(record, 11)[10] ?? '' });
		} else if (record.startsWith('? ')) {
			status.entries.push({ kind: 'untracked', path: record.slice(2) });
		}
	}
	return status;
}

/** A record's first `count - 1` space-separated fields, then the rest (a path, which may contain spaces). */
function splitFields(record: string, count: number): string[] {
	const fields: string[] = [];
	let rest = record;
	for (let n = 1; n < count; n++) {
		const space = rest.indexOf(' ');
		if (space < 0) break;
		fields.push(rest.slice(0, space));
		rest = rest.slice(space + 1);
	}
	fields.push(rest);
	return fields;
}

function ordinaryKind(xy: string): ChangeKind {
	const [x, y] = [xy[0], xy[1]];
	if (x === 'A') return 'added';
	if (x === 'D' || y === 'D') return 'deleted';
	return 'modified';
}

export interface LogEntry {
	hash: string;
	shortHash: string;
	subject: string;
	/** Commit time in milliseconds since the epoch. */
	time: number;
}

/** The `--format` that `parseLog` reads. */
export const LOG_FORMAT = '%H%x1f%h%x1f%s%x1f%ct%x1e';

export function parseLog(output: string): LogEntry[] {
	return output
		.split('\x1e')
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [hash = '', shortHash = '', subject = '', time = '0'] = record.split('\x1f');
			return { hash, shortHash, subject, time: Number(time) * 1000 };
		});
}

/** Parses `--name-status -z` into the files one commit touched. */
export function parseNameStatus(output: string): StatusEntry[] {
	const entries: StatusEntry[] = [];
	const fields = output.split('\0');
	for (let i = 0; i < fields.length; i++) {
		const code = fields[i] ?? '';
		if (!code) continue;
		const letter = code[0];
		if (letter === 'R' || letter === 'C') {
			const fromPath = fields[++i] ?? '';
			const path = fields[++i] ?? '';
			entries.push(letter === 'R' ? { kind: 'renamed', path, fromPath } : { kind: 'added', path });
		} else {
			const path = fields[++i] ?? '';
			const kind: ChangeKind = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'U' ? 'conflicted' : 'modified';
			entries.push({ kind, path });
		}
	}
	return entries;
}

export type DiffLineType = 'hunk' | 'add' | 'del' | 'context' | 'note';

export interface DiffLine {
	type: DiffLineType;
	text: string;
}

export interface Diff {
	binary: boolean;
	lines: DiffLine[];
}

/** Parses one file's unified diff, dropping the file headers that the view shows its own way. */
export function parseDiff(output: string): Diff {
	const lines: DiffLine[] = [];
	let binary = false;
	let inHunk = false;
	for (const line of output.split('\n')) {
		if (line.startsWith('diff --git ')) {
			inHunk = false;
		} else if (line.startsWith('@@')) {
			inHunk = true;
			lines.push({ type: 'hunk', text: line });
		} else if (!inHunk) {
			if (line.startsWith('Binary files ')) binary = true;
		} else if (line.startsWith('+')) {
			lines.push({ type: 'add', text: line.slice(1) });
		} else if (line.startsWith('-')) {
			lines.push({ type: 'del', text: line.slice(1) });
		} else if (line.startsWith(' ')) {
			lines.push({ type: 'context', text: line.slice(1) });
		} else if (line.startsWith('\\')) {
			lines.push({ type: 'note', text: line.slice(2) });
		}
	}
	return { binary, lines };
}
