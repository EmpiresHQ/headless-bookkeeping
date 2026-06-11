import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

export interface Profile {
  baseUrl: string;
  token: string;
}

export interface CliConfig {
  currentProfile: string;
  profiles: Record<string, Profile>;
}

export interface ResolvedContext {
  baseUrl: string;
  token: string;
  profile: string;
}

/** CLI flags that influence context resolution. */
export interface ContextFlags {
  profile?: string;
  url?: string;
  token?: string;
}

/** Relevant environment variables. */
export interface ContextEnv {
  HBK_URL?: string;
  HBK_TOKEN?: string;
}

export const CONFIG_DIR = join(homedir(), '.config', 'hbk');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const EMPTY: CliConfig = { currentProfile: 'default', profiles: {} };

/**
 * Pure resolution of the active context. Precedence (highest first):
 *   1. flags  --url / --token / --profile
 *   2. env    HBK_URL / HBK_TOKEN
 *   3. the selected profile in config (flags.profile or config.currentProfile)
 * Throws if no baseUrl/token can be assembled.
 */
export function resolveContext(
  flags: ContextFlags,
  env: ContextEnv,
  config: CliConfig,
): ResolvedContext {
  const profileName = flags.profile ?? config.currentProfile;
  const profile = config.profiles[profileName];

  const baseUrl = flags.url ?? env.HBK_URL ?? profile?.baseUrl;
  const token = flags.token ?? env.HBK_TOKEN ?? profile?.token;

  if (!token) {
    throw new Error(
      `No token: pass --token, set HBK_TOKEN, or run "hbk login" (profile "${profileName}").`,
    );
  }
  if (!baseUrl) {
    throw new Error(
      `No base URL: pass --url, set HBK_URL, or run "hbk login" (profile "${profileName}").`,
    );
  }
  return { baseUrl, token, profile: profileName };
}

/** Read config from disk; returns an empty config if the file is absent. */
export function readConfig(path: string = CONFIG_PATH): CliConfig {
  if (!existsSync(path)) return { ...EMPTY };
  return JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
}

/** Persist config (0600) creating the directory if needed. */
export function writeConfig(
  config: CliConfig,
  path: string = CONFIG_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(path, 0o600);
}

/** Upsert a profile and make it current. */
export function upsertProfile(
  config: CliConfig,
  name: string,
  profile: Profile,
): CliConfig {
  return {
    currentProfile: name,
    profiles: { ...config.profiles, [name]: profile },
  };
}
