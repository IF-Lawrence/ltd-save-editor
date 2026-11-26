import { enumOptionName, murmur3_x86_32, type Accessor } from '@alexislours/ltd-savedata';
import { PLAYER_SCHEMA } from '@alexislours/ltd-savedata/schema';
import type { DecodedRgba, FitMode } from '$lib/ugc/texture/textureReplaceState.svelte';
import {
  UGC_KINDS,
  addBlankUgc,
  buildSidecarZip,
  listUgcSlots,
  type SidecarFile,
  type SidecarSource,
  type UgcKind,
} from '$lib/shareMii';
import { hasOriginal } from '$lib/shareMii/sidecar/sidecarStore.svelte';
import {
  getUgcNamingLanguage,
  UGC_HASH_INDICES,
  UGC_MAX_SLOTS,
  ugcCanvasFileName,
  ugcTexFileName,
  ugcThumbFileName,
} from '@alexislours/ltd-sharemii';
import type { Bc1Mode, Encoder, Matte } from './codec';
import { parseSidecarIds } from './sidecarParse';

const UGC_NAME_LEAVES = {
  Cloth: PLAYER_SCHEMA.UGC.Cloth.Name,
  Food: PLAYER_SCHEMA.UGC.Food.Name,
  Goods: PLAYER_SCHEMA.UGC.Goods.Name,
  Interior: PLAYER_SCHEMA.UGC.Interior.Name,
  Exterior: PLAYER_SCHEMA.UGC.Exterior.Name,
  MapObject: PLAYER_SCHEMA.UGC.MapObject.Name,
  MapFloor: PLAYER_SCHEMA.UGC.MapFloor.Name,
} as const;

const UGC_NETWORK_DELIVER_LEAVES = {
  Cloth: PLAYER_SCHEMA.UGC.Cloth.NetworkDeliverCount,
  Food: PLAYER_SCHEMA.UGC.Food.NetworkDeliverCount,
  Goods: PLAYER_SCHEMA.UGC.Goods.NetworkDeliverCount,
  Interior: PLAYER_SCHEMA.UGC.Interior.NetworkDeliverCount,
  Exterior: PLAYER_SCHEMA.UGC.Exterior.NetworkDeliverCount,
  MapObject: PLAYER_SCHEMA.UGC.MapObject.NetworkDeliverCount,
  MapFloor: PLAYER_SCHEMA.UGC.MapFloor.NetworkDeliverCount,
} as const;

const UGC_SUBTYPE_LEAVES = {
  Cloth: PLAYER_SCHEMA.UGC.Cloth.UgcClothType,
  Food: PLAYER_SCHEMA.UGC.Food.AttrType,
  Goods: PLAYER_SCHEMA.UGC.Goods.UgcGoodsType,
  Interior: PLAYER_SCHEMA.UGC.Interior.UgcInteriorMaterialType,
  Exterior: PLAYER_SCHEMA.UGC.Exterior.UgcMaterialType,
  MapObject: PLAYER_SCHEMA.UGC.MapObject.UgcMapObjectType,
  MapFloor: PLAYER_SCHEMA.UGC.MapFloor.UgcFloorMaterialType,
} as const;

type KnownUgcSubtype = (typeof UGC_SUBTYPE_LEAVES)[UgcKind]['options'][number];
export type UgcSubtype = KnownUgcSubtype | 'unknown';
export type UgcRow = { slot: number; name: string; subtype?: UgcSubtype };

export function getUgcSlotSubtype(
  player: Accessor<'player'>,
  kind: UgcKind,
  slot: number,
): UgcSubtype | undefined {
  const leaf = UGC_SUBTYPE_LEAVES[kind];
  if (!player.has(leaf)) return undefined;
  const name = enumOptionName(player.getElement(leaf, slot - 1) >>> 0);
  return leaf.options.find((option) => option === name) ?? 'unknown';
}

export function getUgcSubtypeOptions(
  player: Accessor<'player'> | null,
  kind: UgcKind,
): KnownUgcSubtype[] {
  const leaf = UGC_SUBTYPE_LEAVES[kind];
  return player?.has(leaf) ? leaf.options.filter((name) => name !== 'Invalid') : [];
}

const { Goods } = PLAYER_SCHEMA.UGC;
const GOODS_SUBTYPE_FIELDS = {
  Book: [Goods.BookType],
  CD: [Goods.CDSound],
  DVD: [Goods.DVDSound],
  Game: [Goods.GameSound],
  Pet: [Goods.PetBehavior, Goods.PetDirection, Goods.PetVoiceType, Goods.PetVoiceEffectType],
  Other: [Goods.OtherEffect],
} as const;

export function setUgcSlotSubtype(
  player: Accessor<'player'>,
  kind: UgcKind,
  slot: number,
  subtype: string,
): boolean {
  const leaf = UGC_SUBTYPE_LEAVES[kind];
  if (
    subtype === 'Invalid' ||
    !leaf.options.some((option) => option === subtype) ||
    !player.has(leaf)
  )
    return false;
  const index = slot - 1;
  const entries = player.get(leaf);
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) return false;
  const hash = murmur3_x86_32(subtype) >>> 0;
  if (entries[index] === hash) return true;

  if (kind === 'Goods') {
    const settings = GOODS_SUBTYPE_FIELDS[subtype as keyof typeof GOODS_SUBTYPE_FIELDS] ?? [];
    const states = player.has(Goods.State) ? player.get(Goods.State) : [];
    const template = entries.findIndex(
      (value, i) => value === hash && states[i] !== undefined && states[i] !== UGC_LOCKED_STATE,
    );
    for (const setting of settings) {
      if (!player.has(setting) || index >= player.get(setting).length) continue;
      const existing = template < 0 ? undefined : player.getElement(setting, template);
      const known = setting.options.some((option) => murmur3_x86_32(option) >>> 0 === existing);
      player.setElement(
        setting,
        index,
        known && existing !== undefined ? existing : murmur3_x86_32(setting.options[0]) >>> 0,
      );
    }
  }
  player.setElement(leaf, index, hash);
  return true;
}

const UGC_LOCKED_STATE = murmur3_x86_32('Lock') >>> 0;
const NO_TEXTURE = murmur3_x86_32('None') >>> 0;
const FRESH_SLOT_FIELDS = new Set([
  'Hash',
  'EntryTime',
  'OwnNum',
  'LastObtainedSec',
  'IsNewlyOwned',
  'NetworkUuid',
  'NetworkDeliverCount',
]);

type UgcRowLabels = {
  unnamed: (slot: number) => string;
};

function listSidecarSlots(sidecar: SidecarSource, kind: UgcKind): number[] {
  return parseSidecarIds(sidecar, `Ugc${kind}`).map((idx) => idx + 1);
}

export function buildUgcRows(
  player: Accessor<'player'> | null,
  kind: UgcKind,
  sidecar: SidecarSource,
  labels: UgcRowLabels,
): UgcRow[] {
  if (player) {
    try {
      const list = listUgcSlots({ player }, kind, sidecar);
      return list
        .filter((s) => !s.isAddNew)
        .map<UgcRow>((s) => ({
          slot: s.slot,
          name: s.name || labels.unnamed(s.slot),
          subtype: getUgcSlotSubtype(player, kind, s.slot),
        }));
    } catch {
      return [];
    }
  }
  return listSidecarSlots(sidecar, kind).map((slot) => ({
    slot,
    name: labels.unnamed(slot),
  }));
}

export function buildKindCounts(
  player: Accessor<'player'> | null,
  sidecar: SidecarSource,
): Record<UgcKind, number> {
  const out = Object.fromEntries(UGC_KINDS.map((k) => [k, 0])) as Record<UgcKind, number>;
  if (player) {
    for (const k of UGC_KINDS) {
      try {
        const list = listUgcSlots({ player }, k, sidecar);
        out[k] = list.filter((s) => !s.isAddNew).length;
      } catch {
        out[k] = 0;
      }
    }
    return out;
  }
  for (const k of UGC_KINDS) {
    out[k] = listSidecarSlots(sidecar, k).length;
  }
  return out;
}

export function slotFileNames(kind: UgcKind, slot: number): string[] {
  const idx = slot - 1;
  return [ugcCanvasFileName(kind, idx), ugcTexFileName(kind, idx), ugcThumbFileName(kind, idx)];
}

export function findUgcCopySlot(
  player: Accessor<'player'>,
  kind: UgcKind,
  sidecar: SidecarSource,
): number {
  const { Name, Hash, State } = PLAYER_SCHEMA.UGC[kind];
  if (!player.has(Name) || !player.has(Hash) || !player.has(State)) return -1;
  const names = player.get(Name);
  const ids = player.get(Hash);
  const states = player.get(State);
  const capacity = Math.min(UGC_MAX_SLOTS[kind], names.length, ids.length, states.length);
  for (let index = 0; index < capacity; index++) {
    if (
      !names[index] &&
      ids[index] === 0 &&
      states[index] === UGC_LOCKED_STATE &&
      slotFileNames(kind, index + 1).every((name) => !sidecar.files.has(name))
    )
      return index + 1;
  }
  return -1;
}

export function canCopyUgcItem(
  player: Accessor<'player'>,
  kind: UgcKind,
  slot: number,
  sidecar: SidecarSource,
): boolean {
  const index = slot - 1;
  const { Hash, State, TextureSourceType } = PLAYER_SCHEMA.UGC[kind];
  const subtype = getUgcSlotSubtype(player, kind, slot);
  return (
    subtype !== undefined &&
    subtype !== 'Invalid' &&
    subtype !== 'unknown' &&
    player.has(Hash) &&
    player.getElement(Hash, index) > 0 &&
    player.has(State) &&
    player.getElement(State, index) !== UGC_LOCKED_STATE &&
    player.has(TextureSourceType) &&
    player.getElement(TextureSourceType, index) !== NO_TEXTURE &&
    !hasLanRestriction(player, kind, slot) &&
    slotFileNames(kind, slot).every((name) => (sidecar.files.get(name)?.length ?? 0) > 0)
  );
}

export function duplicateUgcItem(
  player: Accessor<'player'>,
  kind: UgcKind,
  source: number,
  sidecar: SidecarSource,
): { slot: number; writes: Map<string, Uint8Array> } | null {
  if (!canCopyUgcItem(player, kind, source, sidecar)) return null;
  const slot = findUgcCopySlot(player, kind, sidecar);
  if (slot < 0) return null;
  const from = source - 1;
  const to = slot - 1;
  const fields = PLAYER_SCHEMA.UGC[kind];
  const textures = slotFileNames(kind, source).map((name) => sidecar.files.get(name)!.slice());
  const values = Object.entries(fields)
    .filter(([name, leaf]) => !FRESH_SLOT_FIELDS.has(name) && player.has(leaf))
    .map(([, leaf]) => {
      const data = player.get(leaf);
      const value = Array.isArray(data) ? data[from] : undefined;
      return {
        leaf,
        value: typeof value === 'object' ? { ...value } : value,
        length: Array.isArray(data) ? data.length : 0,
      };
    });

  const freshValues = [
    { leaf: fields.EntryTime, value: BigInt(Math.floor(Date.now() / 1000)) },
    { leaf: fields.OwnNum, value: 0 },
    { leaf: fields.LastObtainedSec, value: 0n },
    { leaf: fields.IsNewlyOwned, value: false },
    { leaf: fields.NetworkUuid, value: '' },
    { leaf: fields.NetworkDeliverCount, value: 0 },
  ].filter(({ leaf }) => player.has(leaf));

  if (
    values.some(({ value, length }) => value === undefined || to >= length) ||
    freshValues.some(({ leaf }) => to >= player.get(leaf).length)
  )
    return null;

  for (const { leaf, value } of values) {
    if (value !== undefined) player.setElement(leaf, to, value);
  }
  for (const { leaf, value } of freshValues) player.setElement(leaf, to, value);
  player.setElement(fields.Hash, to, (UGC_HASH_INDICES[kind] << 16) | to);
  return {
    slot,
    writes: new Map(slotFileNames(kind, slot).map((name, index) => [name, textures[index]])),
  };
}

export function slotPreviewCandidates(kind: UgcKind, slot: number): string[] {
  const idx = slot - 1;
  return [ugcTexFileName(kind, idx), ugcCanvasFileName(kind, idx), ugcThumbFileName(kind, idx)];
}

export function slotThumbName(kind: UgcKind, slot: number): string {
  return ugcThumbFileName(kind, slot - 1);
}

export function getSlotOriginalUgctex(
  sidecar: SidecarSource,
  kind: UgcKind,
  slot: number,
): Uint8Array | null {
  return sidecar.files.get(ugcTexFileName(kind, slot - 1)) ?? null;
}

export function isSlotEdited(kind: UgcKind, slot: number): boolean {
  for (const name of slotFileNames(kind, slot)) {
    if (hasOriginal(name)) return true;
  }
  return false;
}

export function getUgcSlotName(
  player: Accessor<'player'> | null,
  kind: UgcKind,
  slot: number,
): string {
  if (!player) return '';
  const leaf = UGC_NAME_LEAVES[kind];
  if (!player.has(leaf)) return '';
  const arr = player.get(leaf) as string[];
  return arr[slot - 1] ?? '';
}

export async function decodeSidecarToPngUrl(
  sidecar: SidecarSource,
  candidates: string[],
): Promise<string | null> {
  const codec = await import('./codec');
  for (const name of candidates) {
    const bytes = sidecar.files.get(name);
    if (!bytes) continue;
    try {
      const decoded = await codec.decodeZsFile(name, bytes);
      const blob = await codec.rgbaToPngBlob(decoded);
      return URL.createObjectURL(blob);
    } catch (e) {
      console.warn(`UGC preview failed for ${name}`, e);
    }
  }
  return null;
}

type ReplaceArgs = {
  decoded: DecodedRgba;
  kind: UgcKind;
  slot: number;
  sidecar: SidecarSource;
  encodeThumb: boolean;
  fitMode: FitMode;
  matte: Matte | null;
  bc1Mode: Bc1Mode;
  encoder: Encoder;
};

export async function buildReplaceWrites(args: ReplaceArgs): Promise<Map<string, Uint8Array>> {
  const { encodeFromRgba } = await import('./codec');
  const slotIndex = args.slot - 1;
  const ugctexName = ugcTexFileName(args.kind, slotIndex);
  const canvasName = ugcCanvasFileName(args.kind, slotIndex);
  const thumbName = ugcThumbFileName(args.kind, slotIndex);
  const original = args.sidecar.files.get(ugctexName) ?? null;
  const out = await encodeFromRgba(args.decoded, {
    originalUgctex: original,
    encodeThumb: args.encodeThumb,
    fitMode: args.fitMode,
    matte: args.matte,
    bc1Mode: args.bc1Mode,
    encoder: args.encoder,
  });
  const writes = new Map<string, Uint8Array>();
  writes.set(canvasName, out.canvas);
  writes.set(ugctexName, out.ugctex);
  if (out.thumb) writes.set(thumbName, out.thumb);
  return writes;
}

export async function buildBlankUgcAdd(
  player: Accessor<'player'>,
  kind: UgcKind,
  sidecar: SidecarSource,
  name: (slot: number) => string,
  subtype: KnownUgcSubtype,
): Promise<{ slot: number; writes: Map<string, Uint8Array> } | null> {
  if (!getUgcSubtypeOptions(player, kind).includes(subtype)) return null;
  const { encodeWhiteUgc } = await import('./codec');
  const tex = await encodeWhiteUgc();
  const slot = findUgcCopySlot(player, kind, sidecar);
  if (slot < 0 || slot > player.get(UGC_SUBTYPE_LEAVES[kind]).length) return null;
  const result = addBlankUgc({ player }, slot, kind, name(slot), {
    canvas: tex.canvas,
    ugcTex: tex.ugctex,
    thumb: tex.thumb,
  });
  setUgcSlotSubtype(player, kind, slot, subtype);
  const writes = new Map<string, Uint8Array>();
  for (const f of result.textureWrites) writes.set(f.name, f.bytes);
  return { slot, writes };
}

export function setUgcSlotName(
  player: Accessor<'player'>,
  kind: UgcKind,
  slot: number,
  name: string,
): void {
  const leaf = UGC_NAME_LEAVES[kind];
  if (!player.has(leaf)) throw new Error('UGC name array not present in save');
  player.setElement(leaf, slot - 1, name);
  const language = getUgcNamingLanguage(player);
  const region = PLAYER_SCHEMA.UGC[kind].RegionLanguageID;
  if (language !== null && player.has(region)) player.setElement(region, slot - 1, language);
}

export function hasUgcNameLanguageMismatch(
  player: Accessor<'player'> | null,
  kind: UgcKind,
  slot: number,
): boolean {
  if (!player) return false;
  const language = getUgcNamingLanguage(player);
  const region = PLAYER_SCHEMA.UGC[kind].RegionLanguageID;
  return (
    language !== null && player.has(region) && player.getElement(region, slot - 1) !== language
  );
}

export function hasLanRestriction(
  player: Accessor<'player'> | null,
  kind: UgcKind,
  slot: number,
): boolean {
  if (!player) return false;
  const leaf = UGC_NETWORK_DELIVER_LEAVES[kind];
  if (!player.has(leaf)) return false;
  const arr = player.get(leaf) as number[];
  return (arr[slot - 1] ?? 0) > 0;
}

export function clearLanRestriction(player: Accessor<'player'>, kind: UgcKind, slot: number): void {
  const leaf = UGC_NETWORK_DELIVER_LEAVES[kind];
  if (!player.has(leaf)) throw new Error('UGC NetworkDeliverCount array not present in save');
  player.setElement(leaf, slot - 1, 0);
}

export function exportSlotZsFiles(
  sidecar: SidecarSource,
  kind: UgcKind,
  slot: number,
): { fileName: string; bytes: Uint8Array; count: number } | null {
  const slotIdx = slot - 1;
  const names = [
    ugcCanvasFileName(kind, slotIdx),
    ugcTexFileName(kind, slotIdx),
    ugcThumbFileName(kind, slotIdx),
  ];
  const files: SidecarFile[] = [];
  for (const name of names) {
    const bytes = sidecar.files.get(name);
    if (bytes) files.push({ name, bytes });
  }
  if (files.length === 0) return null;
  const fileName = `Ugc${kind}${String(slotIdx).padStart(3, '0')}.zip`;
  return { fileName, bytes: buildSidecarZip(files), count: files.length };
}

export async function decodeSlotCanvasToPng(
  sidecar: SidecarSource,
  kind: UgcKind,
  slot: number,
): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  const slotIdx = slot - 1;
  const canvasName = ugcCanvasFileName(kind, slotIdx);
  const bytes = sidecar.files.get(canvasName);
  if (!bytes) return null;
  const { decodeZsFile, rgbaToPngBlob } = await import('./codec');
  const decoded = await decodeZsFile(canvasName, bytes);
  const blob = await rgbaToPngBlob(decoded);
  const ab = await blob.arrayBuffer();
  const fileName = `${kind}${String(slotIdx).padStart(3, '0')}_canvas.png`;
  return { fileName, bytes: new Uint8Array(ab) };
}

export async function decodeSlotToPng(
  sidecar: SidecarSource,
  kind: UgcKind,
  slot: number,
): Promise<{ fileName: string; bytes: Uint8Array } | null> {
  const slotIdx = slot - 1;
  const ugctexName = ugcTexFileName(kind, slotIdx);
  const canvasName = ugcCanvasFileName(kind, slotIdx);
  const thumbName = ugcThumbFileName(kind, slotIdx);
  const pickName =
    (sidecar.files.has(ugctexName) && ugctexName) ||
    (sidecar.files.has(canvasName) && canvasName) ||
    (sidecar.files.has(thumbName) && thumbName);
  if (!pickName) return null;
  const bytes = sidecar.files.get(pickName)!;
  const { decodeZsFile, rgbaToPngBlob } = await import('./codec');
  const decoded = await decodeZsFile(pickName, bytes);
  const blob = await rgbaToPngBlob(decoded);
  const ab = await blob.arrayBuffer();
  const fileName = `${kind}${String(slotIdx).padStart(3, '0')}.png`;
  return { fileName, bytes: new Uint8Array(ab) };
}
