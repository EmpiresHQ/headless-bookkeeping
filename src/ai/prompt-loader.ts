import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Load a prompt markdown file from src/prompts/ (or dist/prompts/ in production).
 *
 * Supports optional Mustache-style interpolation: {{ variableName }}
 */
export function loadPrompt(
  name: string,
  variables?: Record<string, string>,
): string {
  const filePath = join(__dirname, '..', 'prompts', `${name}.md`);
  let content = readFileSync(filePath, 'utf-8');

  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      content = content.replace(
        new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'),
        value,
      );
    }
  }

  return content;
}
