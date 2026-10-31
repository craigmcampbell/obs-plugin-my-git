# My Git

An Obsidian sidebar for committing, pulling and pushing a vault's git repository without a terminal. Terms follow git's own vocabulary.

## Language

**Repository**:
The git repository that contains the vault, either rooted at the vault folder or at a folder above it.
_Avoid_: Repo (in UI text), project

**Change**:
A file inside the vault whose content differs from the last commit: modified, added, deleted, renamed or untracked.
_Avoid_: Pending file, dirty file

**Selected Change**:
A Change whose checkbox is ticked, and so will be included in the next commit.
_Avoid_: Staged file

**Commit**:
To record the Selected Changes in the Repository's history with a message; also the recorded entry itself.
_Avoid_: Check in, save, snapshot

**Remote**:
Another copy of the Repository, usually hosted, that commits are pulled from and pushed to.

**Upstream**:
The remote branch that the current branch pulls from and pushes to.
_Avoid_: Tracking branch

**Pull**:
To bring the Upstream's new commits into the current branch.
_Avoid_: Sync, update

**Push**:
To send the current branch's new commits to its Upstream.
_Avoid_: Sync, upload

**Fetch**:
To learn what new commits the Remote has without changing any files in the vault.

**Ahead / Behind**:
The number of commits the current branch has that its Upstream lacks (ahead), and the reverse (behind).

**Discard**:
To throw away a Change, restoring the file to its last committed version or removing it if it was never committed.
_Avoid_: Revert, reset

**Unfinished Operation**:
A merge, rebase, cherry-pick or revert left part-way, or a detached HEAD, during which the plugin will not Commit, Pull or Push.

**Conflict**:
A Pull that cannot finish because the same lines were changed both locally and on the Remote.
