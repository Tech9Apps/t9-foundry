import * as fs from 'fs';
import * as path from 'path';

let cachedConfig: Record<string, unknown> | null = null;

export function loadQAConfig(): Record<string, unknown> {
  if (cachedConfig) return cachedConfig;

  // Search for qa-config.json: QA_HARNESS_DIR first (the common case when the
  // harness and app repo are sibling directories, e.g. ~/projects/tech9foundry/
  // and ~/projects/my-app/), then walking up from the test directory (covers
  // a harness nested inside the app repo).
  const searchPaths: string[] = [];
  if (process.env.QA_HARNESS_DIR) {
    searchPaths.push(path.resolve(process.env.QA_HARNESS_DIR, 'qa-config.json'));
  }
  searchPaths.push(
    path.resolve(process.cwd(), 'qa-config.json'),
    path.resolve(process.cwd(), '..', 'qa-config.json'),
    path.resolve(process.cwd(), '..', '..', 'qa-config.json'),
  );

  let foundButMalformed: { configPath: string; error: string } | null = null;

  for (const configPath of searchPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        cachedConfig = JSON.parse(raw);
        return cachedConfig!;
      } catch (err) {
        // Found the file but couldn't parse it — keep searching remaining
        // candidates, but remember this so the final warning is accurate.
        foundButMalformed = { configPath, error: (err as Error).message };
      }
    }
  }

  if (foundButMalformed) {
    // Unattended runs fail closed: continuing would silently run WITHOUT the production patterns this file holds.
    if (process.env.QA_AUTONOMOUS === '1') {
      throw new Error(
        `BLOCKED: qa-config.json found at ${foundButMalformed.configPath} but could not be parsed (${foundButMalformed.error}), ` +
        'so its production patterns cannot be applied. Fix the file; unattended runs (QA_AUTONOMOUS=1) do not continue without it.'
      );
    }
    console.warn(
      `qa-config.json found at ${foundButMalformed.configPath} but could not be parsed ` +
      `(${foundButMalformed.error}). Using environment variables only.`
    );
  } else {
    console.warn(
      'qa-config.json not found (checked QA_HARNESS_DIR and the test directory upward). ' +
      'Using environment variables only. Set QA_HARNESS_DIR to the tech9foundry directory, ' +
      'or run /connect-repo in the QA harness to configure the workspace.'
    );
  }
  return {};
}
