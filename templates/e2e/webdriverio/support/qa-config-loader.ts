import * as fs from 'fs';
import * as path from 'path';

let cachedConfig: Record<string, unknown> | null = null;

export function loadQAConfig(): Record<string, unknown> {
  if (cachedConfig) return cachedConfig;

  const searchPaths = [
    process.env.QA_HARNESS_DIR
      ? path.resolve(process.env.QA_HARNESS_DIR, 'qa-config.json')
      : null,
    path.resolve(process.cwd(), 'qa-config.json'),
    path.resolve(process.cwd(), '..', 'qa-config.json'),
    path.resolve(process.cwd(), '..', '..', 'qa-config.json'),
  ].filter(Boolean) as string[];

  let foundButMalformed: { configPath: string; error: string } | null = null;

  for (const configPath of searchPaths) {
    if (fs.existsSync(configPath)) {
      try {
        cachedConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        return cachedConfig!;
      } catch (err) {
        // Found the file but couldn't parse it — keep searching remaining
        // candidates, but remember this so the final warning is accurate.
        foundButMalformed = { configPath, error: (err as Error).message };
      }
    }
  }

  if (foundButMalformed) {
    console.warn(
      `qa-config.json found at ${foundButMalformed.configPath} but could not be parsed ` +
      `(${foundButMalformed.error}). Using environment variables only.`
    );
  } else {
    console.warn(
      'qa-config.json not found. Using environment variables only. ' +
      'Run /connect-repo in the QA harness to configure the workspace.'
    );
  }
  return {};
}
