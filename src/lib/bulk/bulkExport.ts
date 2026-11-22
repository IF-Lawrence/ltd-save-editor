import { zipSync } from 'fflate';
import { track } from '$lib/analytics';
import { loadS2ArmArchive, writeS2ArmArchive, type S2ArmSource } from '$lib/bulk/s2armArchive';
import { downloadBytes } from '$lib/sav/download';
import { getSave, getSaveBytes, isSaveLoaded } from '$lib/saveFile/saveFile.svelte';
import { expectedFileName, SAVE_KINDS, type SaveKind } from '$lib/saveFile/types';
import { getSidecarStore } from '$lib/shareMii/sidecar/sidecarStore.svelte';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function timestamp(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${date}_${time}`;
}

export function loadedKinds(): SaveKind[] {
  return SAVE_KINDS.filter((k) => getSave(k) != null);
}

export function canExportS2Arm(): boolean {
  return SAVE_KINDS.every(isSaveLoaded);
}

export function getS2ArmExportSource(): S2ArmSource | null {
  const player = getSave('player');
  if (!player?.s2armId || !player.s2armSource) return null;
  const { s2armId: id, s2armSource: bytes } = player;
  return SAVE_KINDS.every((kind) => {
    const save = getSave(kind);
    return save?.decoded != null && save.s2armId === id;
  })
    ? { id, bytes }
    : null;
}

export async function exportAllSaves(template?: File): Promise<number> {
  const source = getS2ArmExportSource();
  const complete = canExportS2Arm();
  if (complete && !source && !template) throw new Error('An S2Arm save template is required');
  const kinds = loadedKinds();
  const sidecar = getSidecarStore();
  if (kinds.length === 0 && sidecar.files.size === 0) return 0;

  const entries: Record<string, Uint8Array> = {};
  for (const kind of kinds) {
    const bytes = getSaveBytes(kind);
    if (bytes) entries[expectedFileName[kind]] = bytes;
  }
  for (const [name, bytes] of sidecar.files) {
    entries[`Ugc/${name}`] = bytes;
  }

  let archive = source?.bytes;
  if (complete && !archive && template) {
    archive = new Uint8Array(await template.arrayBuffer());
    await loadS2ArmArchive(archive);
  }
  const bytes = archive
    ? await writeS2ArmArchive(archive, entries)
    : zipSync(entries, { level: 6 });
  downloadBytes(bytes, `LTD-save-${timestamp()}.${archive ? 's2asave' : 'zip'}`);
  track('export', { mode: 'bulk', kinds: kinds.join(','), kind_count: kinds.length });
  return kinds.length;
}
