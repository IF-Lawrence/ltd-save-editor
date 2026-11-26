<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { _ } from 'virtual:i18n/ugc_editor+content_kinds';
  import Card from '$lib/ui/Card.svelte';
  import SaveBar from '$lib/saveFile/SaveBar.svelte';
  import SubTabs from '$lib/ui/SubTabs.svelte';
  import { downloadBytes } from '$lib/sav/download';
  import { errorMessage } from '$lib/errorMessage';
  import { getSave } from '$lib/saveFile/saveFile.svelte';
  import { UGC_KINDS, buildSidecarZip, type UgcKind } from '$lib/shareMii';
  import { playerAccessor, playerState, syncFromSave } from '$lib/player/playerEditor.svelte';
  import { miiAccessor } from '$lib/mii/miiEditor.svelte';
  import { TextureReplaceState } from '$lib/ugc/texture/textureReplaceState.svelte';
  import {
    getSidecarStore,
    pendingSidecarCount,
    pendingSidecarFiles,
    replaceSidecarFiles,
    revertSidecarFiles,
    sidecarOrigin,
  } from '$lib/shareMii/sidecar/sidecarStore.svelte';
  import { CARD_CLASS, INPUT_CLASS, PILL_BUTTON_CLASS } from '$lib/ui/styles';
  import { track } from '$lib/analytics';
  import { showToast } from '$lib/toast/toast.svelte';
  import FacepaintSection from '$lib/ugc/facepaint/FacepaintSection.svelte';
  import { listFacepaints, listFacepaintsFromSidecar } from '$lib/ugc/facepaint/list';
  import {
    buildBlankUgcAdd,
    buildKindCounts,
    buildReplaceWrites,
    buildUgcRows,
    canCopyUgcItem,
    clearLanRestriction,
    decodeSidecarToPngUrl,
    decodeSlotCanvasToPng,
    decodeSlotToPng,
    duplicateUgcItem,
    exportSlotZsFiles,
    findUgcCopySlot,
    getSlotOriginalUgctex,
    getUgcSlotName,
    getUgcSubtypeOptions,
    hasLanRestriction,
    hasUgcNameLanguageMismatch,
    isSlotEdited,
    setUgcSlotName,
    setUgcSlotSubtype,
    slotFileNames,
    slotPreviewCandidates,
    slotThumbName,
    type UgcSubtype,
  } from './ugcEditorPage';
  import UgcDropZone from './UgcDropZone.svelte';
  import UgcSidecarBar from './UgcSidecarBar.svelte';
  import UgcSlotEditor from './UgcSlotEditor.svelte';
  import UgcSlotList from './UgcSlotList.svelte';

  type TabKind = UgcKind | 'FacePaint';
  let activeKind = $state<TabKind>('FacePaint');
  let selectedSlot = $state<number | null>(null);
  let subtypeFilter = $state<UgcSubtype | ''>('');
  let addingBlank = $state(false);
  let newSubtype = $state<Exclude<UgcSubtype, 'unknown'> | ''>('');
  let busy = $state(false);
  let pngInput = $state<HTMLInputElement | null>(null);

  let currentPreview = $state<string | null>(null);
  let regenerateThumb = $state(true);
  let editedName = $state('');
  let currentPreviewToken = 0;

  const tx = new TextureReplaceState(
    (e) => showToast('error', errorMessage(e)),
    (transform) => track('ugc_editor_transform', { transform }),
  );

  function revokeCurrentPreview(): void {
    if (currentPreview) {
      URL.revokeObjectURL(currentPreview);
      currentPreview = null;
    }
  }

  const playerSave = $derived(getSave('player'));
  const sidecar = $derived(getSidecarStore());
  const playerless = $derived(!playerSave);
  const sidecarLoaded = $derived(sidecarOrigin() !== 'none');

  const ugcKind = $derived<UgcKind | null>(
    activeKind === 'FacePaint' ? null : (activeKind as UgcKind),
  );

  $effect(() => {
    void playerSave;
    syncFromSave();
  });

  const kindCounts = $derived.by<Record<UgcKind, number>>(() => {
    void playerState.dirty;
    return buildKindCounts(playerAccessor(), sidecar);
  });

  const facepaintCount = $derived.by(() => {
    void playerState.dirty;
    void sidecar.files.size;
    const acc = playerAccessor();
    try {
      if (acc) return listFacepaints(acc, miiAccessor()).length;
      return listFacepaintsFromSidecar(sidecar).length;
    } catch {
      return 0;
    }
  });

  const kindTabs = $derived([
    {
      value: 'FacePaint' as TabKind,
      label:
        facepaintCount > 0
          ? `${$_('content_kinds.FacePaint')} (${facepaintCount})`
          : $_('content_kinds.FacePaint'),
    },
    ...UGC_KINDS.map((k) => {
      const base = $_(`content_kinds.${k}`);
      const n = kindCounts[k];
      return { value: k as TabKind, label: n > 0 ? `${base} (${n})` : base };
    }),
  ]);

  const rows = $derived.by(() => {
    void playerState.rev;
    if (!ugcKind) return [];
    return buildUgcRows(playerAccessor(), ugcKind, sidecar, {
      unnamed: (slot) => $_('ugc_editor.list.unnamed', { values: { slot } }),
    });
  });
  const subtypes = $derived([
    ...new Set(rows.flatMap((row) => (row.subtype ? [row.subtype] : []))),
  ]);
  const visibleRows = $derived(
    rows
      .filter((row) => !subtypeFilter || row.subtype === subtypeFilter)
      .map((row) => ({
        ...row,
        subtypeLabel: row.subtype ? $_(`ugc_editor.subtype.${row.subtype}`) : undefined,
      })),
  );
  const subtypeOptions = $derived(ugcKind ? getUgcSubtypeOptions(playerAccessor(), ugcKind) : []);
  const selectedSubtype = $derived(rows.find((row) => row.slot === selectedSlot)?.subtype);

  const currentName = $derived.by(() => {
    if (selectedSlot === null || !ugcKind) return '';
    return getUgcSlotName(playerAccessor(), ugcKind, selectedSlot);
  });
  const nameLanguageMismatch = $derived(
    selectedSlot !== null &&
      ugcKind !== null &&
      hasUgcNameLanguageMismatch(playerAccessor(), ugcKind, selectedSlot),
  );

  const selectedHasThumb = $derived.by(() => {
    if (selectedSlot === null || !ugcKind) return false;
    return sidecar.files.has(slotThumbName(ugcKind, selectedSlot));
  });

  const selectedIsEdited = $derived.by(() => {
    if (selectedSlot === null || !ugcKind) return false;
    void sidecar.files.size;
    return isSlotEdited(ugcKind, selectedSlot);
  });

  const copySlot = $derived.by(() => {
    void playerState.rev;
    const acc = playerAccessor();
    return ugcKind && acc && sidecarLoaded ? findUgcCopySlot(acc, ugcKind, sidecar) : -1;
  });
  const canAddBlank = $derived(copySlot > 0 && subtypeOptions.length > 0);
  const copyUnavailable = $derived.by(() => {
    void playerState.rev;
    const acc = playerAccessor();
    if (!acc || !ugcKind || selectedSlot === null) return '';
    if (selectedHasLanRestriction) return $_('ugc_editor.editor.copy_restricted');
    if (!canCopyUgcItem(acc, ugcKind, selectedSlot, sidecar)) {
      return $_('ugc_editor.editor.copy_needs_template');
    }
    return copySlot < 0 ? $_('ugc_editor.toast.add_full') : '';
  });

  const selectedHasLanRestriction = $derived.by(() => {
    void playerState.dirty;
    if (selectedSlot === null || !ugcKind) return false;
    return hasLanRestriction(playerAccessor(), ugcKind, selectedSlot);
  });

  $effect(() => {
    void sidecar.files.size;
    void playerSave?.loadId;
    untrack(() => {
      if (activeKind === 'FacePaint' ? facepaintCount > 0 : kindCounts[activeKind] > 0) return;
      if (facepaintCount > 0) {
        activeKind = 'FacePaint';
        return;
      }
      const firstWithContent = UGC_KINDS.find((k) => kindCounts[k] > 0);
      if (firstWithContent) activeKind = firstWithContent;
    });
  });

  $effect(() => {
    void activeKind;
    void playerSave?.loadId;
    untrack(() => {
      selectedSlot = null;
      subtypeFilter = '';
      addingBlank = false;
      newSubtype = '';
      tx.reset();
      revokeCurrentPreview();
    });
  });

  $effect(() => {
    const slot = selectedSlot;
    const kind = ugcKind;
    void sidecar.files.size;
    if (slot === null || !kind) {
      revokeCurrentPreview();
      tx.originalUgctex = null;
      return;
    }
    tx.originalUgctex = getSlotOriginalUgctex(sidecar, kind, slot);
    untrack(() => {
      regenerateThumb = true;
      void loadCurrentPreview(kind, slot);
    });
  });

  $effect(() => {
    const next = currentName;
    untrack(() => {
      editedName = next;
    });
  });

  async function loadCurrentPreview(kind: UgcKind, slot: number): Promise<void> {
    const token = ++currentPreviewToken;
    revokeCurrentPreview();
    const url = await decodeSidecarToPngUrl(sidecar, slotPreviewCandidates(kind, slot));
    if (!url) return;
    const stillCurrent = token === currentPreviewToken && selectedSlot === slot && ugcKind === kind;
    if (!stillCurrent) {
      URL.revokeObjectURL(url);
      return;
    }
    currentPreview = url;
  }

  function onPngPicked(event: Event): void {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    target.value = '';
    if (!file) return;
    void tx.loadFile(file);
  }

  function applyRename(): void {
    if (busy || selectedSlot === null || !ugcKind) return;
    const trimmed = editedName.trim();
    if (trimmed.length === 0) {
      showToast('warn', $_('ugc_editor.editor.rename.empty'));
      return;
    }
    if (trimmed === currentName && !nameLanguageMismatch) return;
    const acc = playerAccessor();
    if (!acc) return;
    try {
      setUgcSlotName(acc, ugcKind, selectedSlot, trimmed);
      track('ugc_editor_rename', { kind: ugcKind, slot: selectedSlot });
      showToast(
        'success',
        $_('ugc_editor.editor.rename.saved', { values: { slot: selectedSlot } }),
      );
    } catch (e) {
      showToast('error', errorMessage(e));
    }
  }

  async function addBlank(): Promise<void> {
    if (busy || !ugcKind || !canAddBlank || !newSubtype) return;
    const acc = playerAccessor();
    if (!acc) return;
    const kind = ugcKind;
    busy = true;
    try {
      const result = await buildBlankUgcAdd(
        acc,
        kind,
        sidecar,
        (slot) => $_('ugc_editor.list.unnamed', { values: { slot } }),
        newSubtype,
      );
      if (!result) {
        showToast('warn', $_('ugc_editor.toast.add_full'));
        return;
      }
      replaceSidecarFiles(result.writes);
      if (ugcKind === kind) {
        subtypeFilter = '';
        addingBlank = false;
        newSubtype = '';
        selectRow(result.slot);
      }
      track('ugc_editor_add_blank', { kind, slot: result.slot });
      showToast('success', $_('ugc_editor.toast.added', { values: { slot: result.slot } }));
    } catch (e) {
      showToast('error', errorMessage(e));
    } finally {
      busy = false;
    }
  }

  function changeSubtype(subtype: string): void {
    const acc = playerAccessor();
    if (busy || !acc || !ugcKind || selectedSlot === null) return;
    if (!setUgcSlotSubtype(acc, ugcKind, selectedSlot, subtype)) return;
    if (subtypeFilter && subtypeFilter !== subtype) subtypeFilter = '';
    showToast('success', $_('ugc_editor.toast.subtype_changed'));
  }

  function copySelected(): void {
    if (busy || !ugcKind || selectedSlot === null || copyUnavailable) return;
    const acc = playerAccessor();
    if (!acc) return;
    try {
      const result = duplicateUgcItem(acc, ugcKind, selectedSlot, sidecar);
      if (!result) {
        showToast('warn', $_('ugc_editor.editor.copy_needs_template'));
        return;
      }
      replaceSidecarFiles(result.writes);
      selectRow(result.slot);
      showToast('success', $_('ugc_editor.toast.copied', { values: { slot: result.slot } }));
    } catch (e) {
      showToast('error', errorMessage(e));
    }
  }

  function filterBySubtype(value: UgcSubtype | ''): void {
    subtypeFilter = value;
    if (value && rows.find((row) => row.slot === selectedSlot)?.subtype !== value) {
      selectedSlot = null;
      tx.reset();
      revokeCurrentPreview();
    }
  }

  async function applyReplace(): Promise<void> {
    if (busy || selectedSlot === null || !tx.pendingDecoded || !ugcKind) return;
    busy = true;
    try {
      const writes = await buildReplaceWrites({
        decoded: tx.pendingDecoded,
        kind: ugcKind,
        slot: selectedSlot,
        sidecar,
        encodeThumb: regenerateThumb,
        fitMode: tx.fitMode,
        matte: tx.matteColor,
        bc1Mode: tx.bc1Mode,
        encoder: tx.encoder,
      });
      replaceSidecarFiles(writes);
      track('ugc_editor_replace', {
        kind: ugcKind,
        slot: selectedSlot,
        thumb: regenerateThumb,
        fit: tx.fitMode,
        matte: tx.matteOption,
        bc1Mode: tx.bc1Mode,
        encoder: tx.encoder,
      });
      showToast('success', $_('ugc_editor.toast.replaced', { values: { slot: selectedSlot } }));
      tx.reset();
      await loadCurrentPreview(ugcKind, selectedSlot);
    } catch (e) {
      showToast('error', errorMessage(e));
    } finally {
      busy = false;
    }
  }

  async function exportSelectedAsPng(): Promise<void> {
    if (busy || selectedSlot === null || !ugcKind) return;
    busy = true;
    try {
      const result = await decodeSlotToPng(sidecar, ugcKind, selectedSlot);
      if (!result) {
        showToast('warn', $_('ugc_editor.toast.no_texture'));
        return;
      }
      downloadBytes(result.bytes, result.fileName);
      track('ugc_editor_export', { kind: ugcKind, slot: selectedSlot });
      showToast(
        'success',
        $_('ugc_editor.toast.exported', { values: { fileName: result.fileName } }),
      );
    } catch (e) {
      showToast('error', errorMessage(e));
    } finally {
      busy = false;
    }
  }

  async function exportSelectedCanvasAsPng(): Promise<void> {
    if (busy || selectedSlot === null || !ugcKind) return;
    busy = true;
    try {
      const result = await decodeSlotCanvasToPng(sidecar, ugcKind, selectedSlot);
      if (!result) {
        showToast('warn', $_('ugc_editor.toast.no_canvas'));
        return;
      }
      downloadBytes(result.bytes, result.fileName);
      track('ugc_editor_export_canvas', { kind: ugcKind, slot: selectedSlot });
      showToast(
        'success',
        $_('ugc_editor.toast.exported', { values: { fileName: result.fileName } }),
      );
    } catch (e) {
      showToast('error', errorMessage(e));
    } finally {
      busy = false;
    }
  }

  function exportSelectedAsUgc(): void {
    if (busy || selectedSlot === null || !ugcKind) return;
    const result = exportSlotZsFiles(sidecar, ugcKind, selectedSlot);
    if (!result) {
      showToast('warn', $_('ugc_editor.toast.no_texture'));
      return;
    }
    downloadBytes(result.bytes, result.fileName);
    track('ugc_editor_export_ugc', { kind: ugcKind, slot: selectedSlot, count: result.count });
    showToast(
      'success',
      $_('ugc_editor.toast.exported_ugc', {
        values: { fileName: result.fileName, count: result.count },
      }),
    );
  }

  function clearLan(): void {
    if (busy || selectedSlot === null || !ugcKind) return;
    const acc = playerAccessor();
    if (!acc) return;
    try {
      clearLanRestriction(acc, ugcKind, selectedSlot);
      track('ugc_editor_clear_lan_restriction', { kind: ugcKind, slot: selectedSlot });
      showToast(
        'success',
        $_('ugc_editor.toast.lan_restriction_cleared', { values: { slot: selectedSlot } }),
      );
    } catch (e) {
      showToast('error', errorMessage(e));
    }
  }

  function revertSelected(): void {
    if (busy || selectedSlot === null || !ugcKind) return;
    const names = slotFileNames(ugcKind, selectedSlot);
    const result = revertSidecarFiles(names);
    if (result.restored.length === 0 && result.removed.length === 0) return;
    track('ugc_editor_revert', { kind: ugcKind, slot: selectedSlot });
    showToast('success', $_('ugc_editor.toast.reverted', { values: { slot: selectedSlot } }));
    tx.reset();
    void loadCurrentPreview(ugcKind, selectedSlot);
  }

  function downloadPending(): void {
    const files = pendingSidecarFiles();
    if (files.length === 0) return;
    downloadBytes(buildSidecarZip(files), 'UGC-edits.zip');
    track('ugc_editor_pending_downloaded', { count: files.length });
    showToast(
      'success',
      $_('ugc_editor.toast.downloaded_pending', { values: { count: files.length } }),
    );
  }

  onDestroy(() => {
    revokeCurrentPreview();
    tx.revokeNewPreview();
  });

  function selectRow(slot: number): void {
    if (selectedSlot === slot) return;
    selectedSlot = slot;
    tx.reset();
    revokeCurrentPreview();
  }
</script>

<div class="grid grid-cols-1 gap-6">
  <header class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-2xl font-bold tracking-tight text-content-strong">
        {$_('ugc_editor.title')}
      </h2>
      <p class="mt-1 text-sm text-content">{$_('ugc_editor.description')}</p>
    </div>
  </header>

  {#if playerless && !sidecarLoaded}
    <Card>
      <p class="text-sm text-content">
        {$_('ugc_editor.needs_player_or_folder', { values: { playerSav: 'Player.sav' } })}
      </p>
    </Card>
    <UgcDropZone bind:busy />
  {:else}
    {#if pendingSidecarCount() > 0}
      <SaveBar
        dirty={true}
        actionLabel={$_('ugc_editor.save_bar.download_pending', {
          values: { count: pendingSidecarCount() },
        })}
        onAction={downloadPending}
      />
    {:else if playerSave}
      <SaveBar dirty={playerState.dirty} />
    {/if}

    <UgcSidecarBar bind:busy />

    {#if playerless}
      <p class="flex items-center gap-1.5 text-xs text-warn">
        <svg
          class="h-3.5 w-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 9v3.75m0 3.75h.008v.008H12v-.008zM10.342 3.94l-8.4 14.55A1.5 1.5 0 003.243 21h17.514a1.5 1.5 0 001.301-2.51l-8.4-14.55a1.5 1.5 0 00-2.598 0z"
          />
        </svg>
        {$_('ugc_editor.sidecar_only_notice', { values: { playerSav: 'Player.sav' } })}
      </p>
    {/if}

    <SubTabs tabs={kindTabs} bind:value={activeKind} label={$_('ugc_editor.kind_tabs_label')} />

    <section class={CARD_CLASS}>
      {#if !ugcKind}
        {@const player = playerAccessor()}
        {@const mii = miiAccessor()}
        <FacepaintSection {player} {mii} />
      {:else}
        <div class="grid gap-4 md:grid-cols-[280px_1fr]">
          <div>
            {#if subtypes.length > 0}
              <div class="mb-3 flex items-center gap-2 text-sm text-content">
                <label for="ugc-subtype-filter" class="shrink-0"
                  >{$_('ugc_editor.list.subtype_filter')}</label
                >
                <select
                  id="ugc-subtype-filter"
                  class="{INPUT_CLASS} min-w-0 flex-1"
                  value={subtypeFilter}
                  onchange={(event) =>
                    filterBySubtype(event.currentTarget.value as UgcSubtype | '')}
                >
                  <option value="">{$_('ugc_editor.list.all_subtypes')}</option>
                  {#each subtypes as subtype (subtype)}
                    <option value={subtype}>{$_(`ugc_editor.subtype.${subtype}`)}</option>
                  {/each}
                </select>
              </div>
            {/if}
            <UgcSlotList
              rows={visibleRows}
              kind={ugcKind}
              {sidecar}
              {selectedSlot}
              onSelect={selectRow}
            />
            {#if addingBlank}
              <form
                class="mt-3 space-y-2 rounded-lg border border-edge/60 p-3"
                onsubmit={(event) => {
                  event.preventDefault();
                  void addBlank();
                }}
              >
                <label for="ugc-new-item-subtype" class="block text-sm text-content">
                  {$_('ugc_editor.editor.new_item_subtype')}
                </label>
                <select
                  id="ugc-new-item-subtype"
                  class="{INPUT_CLASS} w-full"
                  bind:value={newSubtype}
                  disabled={busy}
                  required
                >
                  <option value="" disabled>{$_('ugc_editor.editor.pick_subtype')}</option>
                  {#each subtypeOptions as subtype (subtype)}
                    <option value={subtype}>{$_(`ugc_editor.subtype.${subtype}`)}</option>
                  {/each}
                </select>
                <div class="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    class="{PILL_BUTTON_CLASS} disabled:opacity-50"
                    disabled={busy || !canAddBlank || !newSubtype}
                    >{$_('ugc_editor.editor.create_item')}</button
                  >
                  <button
                    type="button"
                    class={PILL_BUTTON_CLASS}
                    disabled={busy}
                    onclick={() => (addingBlank = false)}
                    >{$_('ugc_editor.editor.cancel_add')}</button
                  >
                </div>
              </form>
            {:else if !playerless && sidecarLoaded}
              <button
                type="button"
                class="{PILL_BUTTON_CLASS} mt-3 w-full disabled:cursor-not-allowed disabled:opacity-50"
                onclick={() => {
                  newSubtype = subtypeOptions.find((option) => option === subtypeFilter) ?? '';
                  addingBlank = true;
                }}
                disabled={busy || !canAddBlank}
              >
                {$_('ugc_editor.list.add_blank')}
              </button>
            {/if}
          </div>

          <div>
            {#if selectedSlot === null}
              <p class="text-sm text-content-muted">{$_('ugc_editor.editor.pick_item')}</p>
            {:else}
              <UgcSlotEditor
                {busy}
                bind:editedName
                {currentName}
                {nameLanguageMismatch}
                {currentPreview}
                {tx}
                {selectedHasThumb}
                {selectedIsEdited}
                hasLanRestriction={selectedHasLanRestriction}
                bind:regenerateThumb
                sidecarMissing={sidecarOrigin() === 'none'}
                {playerless}
                {copyUnavailable}
                {selectedSubtype}
                {subtypeOptions}
                onChangeSubtype={changeSubtype}
                onCopy={copySelected}
                onApplyRename={applyRename}
                onPickPng={() => pngInput?.click()}
                onLoadFile={(file) => void tx.loadFile(file)}
                onApplyReplace={applyReplace}
                onExportPng={exportSelectedAsPng}
                onExportCanvasPng={exportSelectedCanvasAsPng}
                onExportUgc={exportSelectedAsUgc}
                onRevertSelected={revertSelected}
                onClearLanRestriction={clearLan}
              />
            {/if}
          </div>
        </div>
      {/if}
    </section>
  {/if}

  <input
    bind:this={pngInput}
    type="file"
    class="hidden"
    accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
    onchange={onPngPicked}
  />
</div>
