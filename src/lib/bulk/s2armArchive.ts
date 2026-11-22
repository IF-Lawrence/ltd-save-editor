import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { expectedFileName } from '$lib/saveFile/types';
import { isSidecarFileName } from '$lib/shareMii/sidecar/sidecar';

export const S2ARM_EXT = /\.s2asave$/i;

export type S2ArmSource = { id: string; bytes: Uint8Array };

type ManifestFile = { path: string; size: number; sha256: string };

type Manifest = {
  format: string;
  schema: number;
  layout: string;
  createdAt: string;
  game: { id: string };
  users: { active?: string };
  saveEntries: { saveId: string; programId: string; type: string; userId: string }[];
  directories: string[];
  files: ManifestFile[];
};

const SAVE_NAMES = new Set<string>(Object.values(expectedFileName));
const GAME_ID = '010051f0207b2000';

function isEditablePath(path: string): boolean {
  return SAVE_NAMES.has(path) || (/^Ugc\/[\w.-]+$/.test(path) && isSidecarFileName(path));
}

function sha256(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest('SHA-256', Uint8Array.from(bytes))
    .then((hash) =>
      Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
}

function readArchive(bytes: Uint8Array) {
  const entries: Record<string, Uint8Array> = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as Manifest;
  if (
    manifest.format !== 'S2ArmSave' ||
    manifest.schema !== 1 ||
    manifest.layout !== 'ryujinx-data-v1' ||
    manifest.game.id.toLowerCase() !== GAME_ID ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.directories)
  ) {
    throw new Error('Unsupported S2Arm save archive');
  }

  const accounts = manifest.saveEntries.filter(
    (entry) => entry.type === 'account' && entry.programId.toLowerCase() === GAME_ID,
  );
  const account =
    accounts.find((entry) => entry.userId === manifest.users.active) ??
    (accounts.length === 1 ? accounts[0] : undefined);
  if (!account || !/^[a-f0-9]{16}$/i.test(account.saveId)) {
    throw new Error('Could not identify the S2Arm player save');
  }
  const root = `bis/user/save/${account.saveId}/`;
  return { entries, manifest, root };
}

export async function loadS2ArmArchive(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  const { entries, manifest, root } = readArchive(bytes);
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  if (files.size !== manifest.files.length || Object.keys(entries).length !== files.size + 1) {
    throw new Error('Invalid S2Arm save manifest');
  }
  await Promise.all(
    manifest.files.map(async ({ path, size, sha256: digest }) => {
      const data = entries[`payload/${path}`];
      if (!data || data.length !== size || (await sha256(data)) !== digest) {
        throw new Error('S2Arm save failed its integrity check');
      }
    }),
  );

  const sources = ['0/', '1/'].map((slot) => {
    const prefix = root + slot;
    return new Map(
      Array.from(files.keys())
        .filter((path) => path.startsWith(prefix) && isEditablePath(path.slice(prefix.length)))
        .map((path) => [path.slice(prefix.length), entries[`payload/${path}`]]),
    );
  });
  const [primary, backup] = sources;
  if (
    primary.size !== backup.size ||
    !Object.values(expectedFileName).every((name) => primary.has(name))
  ) {
    throw new Error('S2Arm save slots are incomplete or different');
  }
  for (const [path, data] of primary) {
    const other = backup.get(path);
    if (other?.length !== data.length || !data.every((value, index) => value === other[index])) {
      throw new Error('S2Arm save slots are different');
    }
  }
  return Object.fromEntries(primary);
}

export async function writeS2ArmArchive(
  source: Uint8Array,
  edits: Record<string, Uint8Array>,
): Promise<Uint8Array> {
  const { entries, manifest, root } = readArchive(source);
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  const directories = new Set(manifest.directories);
  for (const [path, data] of Object.entries(edits)) {
    if (!isEditablePath(path)) throw new Error('Invalid S2Arm save file path');
    const digest = await sha256(data);
    for (const slot of ['0/', '1/']) {
      const target = root + slot + path;
      entries[`payload/${target}`] = data;
      files.set(target, { path: target, size: data.length, sha256: digest });
      if (path.startsWith('Ugc/')) directories.add(root + slot + 'Ugc');
    }
  }
  manifest.createdAt = new Date().toISOString();
  manifest.files = Array.from(files.values());
  manifest.directories = Array.from(directories);
  entries['manifest.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(entries, { level: 6 });
}
