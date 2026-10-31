# Run the system git binary instead of bundling a JS git implementation

The plugin runs the user's installed `git` as a child process rather than bundling isomorphic-git. System git already has the user's SSH keys, credential helper, `.gitconfig` and hooks, so pushing to an SSH remote needs no extra setup, and its behaviour on rebase, renames and large vaults matches what a terminal does. isomorphic-git would have allowed mobile use, but it supports only HTTPS token auth and only part of git's behaviour.

## Consequences

- The plugin is desktop-only.
- Obsidian launched from the Dock may not inherit a shell `PATH`, so settings include an optional path to the git binary.
- Every git operation is asynchronous and can fail with git's own stderr, which the plugin surfaces in notices.
