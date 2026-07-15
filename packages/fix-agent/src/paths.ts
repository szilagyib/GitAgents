import { isAbsolute, resolve } from "path";

export function resolveRepoDir(
  flagValue: string | undefined,
  envValue: string | undefined,
  cwd: string
): string {
  if (flagValue && flagValue.length > 0) return flagValue;
  if (envValue && envValue.length > 0) return envValue;
  return cwd;
}

export function resolveRepoFilePath(repoDir: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(repoDir, filePath);
}
