import { execFile } from 'node:child_process';

/** What one git invocation printed and how it exited. */
export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface RunOptions {
	/** Exit codes that count as success; defaults to 0 only. */
	okCodes?: number[];
	stdin?: string;
}

/** Runs git with `args` in a fixed working directory, rejecting with GitError on an unexpected exit. */
export type Run = (args: string[], options?: RunOptions) => Promise<GitResult>;

export class GitError extends Error {
	readonly args: string[];
	readonly result: GitResult;

	constructor(args: string[], result: GitResult) {
		super(firstLines(result.stderr || result.stdout) || `git ${args[0] ?? ''} failed with exit code ${result.code}`);
		this.args = args;
		this.result = result;
	}
}

/** Thrown when the git binary itself cannot be started. */
export class GitNotFoundError extends Error {
	constructor(gitPath: string) {
		super(`Could not run "${gitPath}". Install git or set its path in My Git settings.`);
	}
}

/** Folders Homebrew and the Xcode tools install git into, which an app launched from the Dock may not have on PATH. */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/** Runs `gitPath` as a child process: no shell, no prompts, English messages, no optional index locks. */
export function gitRunner(gitPath: string, cwd: string): Run {
	const path = [process.env.PATH ?? '', ...EXTRA_PATH].filter(Boolean).join(':');
	const env = {
		...process.env,
		PATH: path,
		LC_ALL: 'C',
		GIT_TERMINAL_PROMPT: '0',
		GIT_OPTIONAL_LOCKS: '0',
		GIT_LITERAL_PATHSPECS: '1',
	};
	return (args, options = {}) =>
		new Promise((resolve, reject) => {
			const child = execFile(gitPath, args, { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
					reject(new GitNotFoundError(gitPath));
					return;
				}
				const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
				const result = { stdout, stderr, code };
				if ((options.okCodes ?? [0]).includes(code)) resolve(result);
				else reject(new GitError(args, result));
			});
			if (options.stdin !== undefined) child.stdin?.end(options.stdin);
		});
}

/** The first few non-empty lines, which is where git puts the useful part of an error. */
function firstLines(text: string, count = 4): string {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, count)
		.join('\n');
}
