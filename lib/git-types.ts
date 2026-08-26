export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
  /** ISO mtime of the file on disk (undefined when the file no longer exists,
   *  e.g. deleted entries). Used by the file explorer to sort the changes
   *  list by modification time and to show the change time inline. */
  modified?: string;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  files: GitFileStatus[];
  additions: number;
  deletions: number;
}

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  patch?: string;
  /** True when the file still exists on disk (false for deleted/scratch files). */
  exists?: boolean;
}
