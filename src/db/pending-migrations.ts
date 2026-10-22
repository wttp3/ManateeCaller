/** Filenames still to apply, in lexical order. Already-recorded names are skipped. */
export function pendingMigrationFiles(files: readonly string[], applied: Iterable<string>): string[] {
  const appliedSet = applied instanceof Set ? applied : new Set(applied);
  return files
    .filter((file) => file.endsWith(".sql") && !appliedSet.has(file))
    .sort();
}
