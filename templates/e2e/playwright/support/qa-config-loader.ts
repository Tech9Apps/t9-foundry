import * as fs from 'fs';
import * as path from 'path';

let cachedConfig: Record<string, unknown> | null = null;

export function loadQAConfig(): Record<string, unknown> {
  if (cachedConfig) return cachedConfig;

  // Search for qa-config.json walking up from the test directory
  const searchPaths = [
    path.resolve(process.cwd(), 'qa-config.json'),
    path.resolve(process.cwd(), '..', 'qa-config.json'),
    path.resolve(process.cwd(), '..', '..', 'qa-config.json'),
  ];

  for (const configPath of searchPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        cachedConfig = JSON.parse(raw);
        return cachedConfig!;
      } catch {
        // continue searching
      }
    }
  }

  console.warn(
    'qa-config.json not found. Using environment variables only. ' +
    'Run /connect-repo in the QA harness to configure the workspace.'
  );
  return {};
}
