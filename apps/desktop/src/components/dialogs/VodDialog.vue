<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import ChannelSearchDropdown from "./_components/ChannelSearchDropdown.vue";
import { Check, Loader2, Search, Clapperboard, Layers } from "@lucide/vue";
import { PLATFORMS } from "@/config/platforms";
import { useStreams } from "@/composables/useStreams";
import { useFavorites } from "@/composables/useFavorites";
import { useChannelSearch, type ChannelSearchResult } from "@/composables/useChannelSearch";
import { parseStreamUrl } from "@/lib/platformParser";
import {
  VOD_PLATFORMS,
  formatClock,
  isSameVod,
  isVodPlatform,
  parseVodUrl,
  vodErrorKey,
  vodsOverlap,
  type Vod,
  type VodPage,
  type VodPlatform,
  type VodRef,
} from "@/lib/vod";

export interface VodDialogTarget {
  platform: VodPlatform;
  channel: string;
}

const props = defineProps<{
  open?: boolean;
  target?: VodDialogTarget | null;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
}>();

const { t, locale } = useI18n();
const { streams, addVod } = useStreams();
const { favorites } = useFavorites();

const platform = ref<VodPlatform>("twitch");
const query = ref("");
const searchTerm = ref("");
const loaded = ref<VodDialogTarget | null>(null);
const vods = ref<Vod[]>([]);
const cursor = ref<string | undefined>();
const status = ref<"idle" | "loading" | "loadingMore" | "resolving" | "error">("idle");
const errorKey = ref("");
const failedThumbnails = ref(new Set<string>());
const activeSearchIndex = ref(-1);
let requestId = 0;

const {
  results: searchResults,
  isLoading: isSearching,
  clear: clearSearch,
} = useChannelSearch().search(searchTerm, platform);

const gridVods = computed(() => streams.value.flatMap((s) => (s.vod ? [s.vod] : [])));

const quickChannels = computed(() => {
  const seen = new Set<string>();
  const out: (VodDialogTarget & { label: string })[] = [];
  const push = (p: string, channel: string, label?: string) => {
    if (!isVodPlatform(p) || !channel) return;
    const key = `${p}:${channel.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ platform: p, channel, label: label || channel });
  };
  streams.value.forEach((s) => push(s.platform, s.channel, s.displayName));
  favorites.value.forEach((f) => push(f.platform, f.channel, f.displayName));
  return out.slice(0, 16);
});

const isAdded = (vod: Vod) => gridVods.value.some((g) => isSameVod(g, vod));

const overlapsWith = (vod: Vod) => {
  const now = Date.now();
  const other = gridVods.value.find((g) => !isSameVod(g, vod) && vodsOverlap(g, vod, now));
  return other ? other.displayName || other.channel : null;
};

const formatDate = (ms: number) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(ms);

const formatViews = (count?: number) =>
  count === undefined
    ? ""
    : new Intl.NumberFormat(locale.value, { notation: "compact", maximumFractionDigits: 1 }).format(
        count
      );

const isBusy = computed(() => status.value === "loading" || status.value === "resolving");

async function loadChannel(target: VodDialogTarget) {
  const channel = target.channel.trim().replace(/^@+/, "").toLowerCase();
  if (!channel) return;

  platform.value = target.platform;
  query.value = channel;
  searchTerm.value = "";
  clearSearch();
  loaded.value = { platform: target.platform, channel };
  vods.value = [];
  cursor.value = undefined;
  errorKey.value = "";
  status.value = "loading";
  const id = ++requestId;

  try {
    const page = await invoke<VodPage>("vod_list", {
      platform: target.platform,
      channel,
      cursor: null,
    });
    if (id !== requestId) return;
    vods.value = page.vods;
    cursor.value = page.cursor;
    status.value = "idle";
  } catch (err) {
    if (id !== requestId) return;
    errorKey.value = vodErrorKey(err);
    status.value = "error";
  }
}

async function loadMore() {
  if (!loaded.value || !cursor.value || status.value !== "idle") return;
  status.value = "loadingMore";
  const id = requestId;
  try {
    const page = await invoke<VodPage>("vod_list", {
      platform: loaded.value.platform,
      channel: loaded.value.channel,
      cursor: cursor.value,
    });
    if (id !== requestId) return;
    vods.value = [
      ...vods.value,
      ...page.vods.filter((v) => !vods.value.some((x) => x.id === v.id)),
    ];
    cursor.value = page.cursor;
  } catch (err) {
    if (id !== requestId) return;
    errorKey.value = vodErrorKey(err);
  } finally {
    if (id === requestId) status.value = "idle";
  }
}

async function addByRef(target: VodRef) {
  status.value = "resolving";
  errorKey.value = "";
  try {
    const vod = await invoke<Vod>("vod_get", { platform: target.platform, id: target.id });
    addVod(vod);
    query.value = "";
    status.value = "idle";
  } catch (err) {
    errorKey.value = vodErrorKey(err);
    status.value = "error";
  }
}

function submit() {
  const input = query.value.trim();
  if (!input || isBusy.value) return;
  clearSearch();

  const vodRef = parseVodUrl(input);
  if (vodRef) {
    addByRef(vodRef);
    return;
  }

  const parsed = parseStreamUrl(input);
  if (parsed && isVodPlatform(parsed.platform)) {
    loadChannel({ platform: parsed.platform, channel: parsed.channel });
    return;
  }

  loadChannel({ platform: platform.value, channel: input });
}

function onInput(e: Event) {
  const value = (e.target as HTMLInputElement).value;
  searchTerm.value = value.includes("/") || value.includes(".") ? "" : value;
}

function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData("text") || "";
  const vodRef = parseVodUrl(text);
  if (vodRef) {
    e.preventDefault();
    addByRef(vodRef);
    return;
  }
  const parsed = parseStreamUrl(text);
  if (parsed && isVodPlatform(parsed.platform)) {
    e.preventDefault();
    loadChannel({ platform: parsed.platform, channel: parsed.channel });
  }
}

function selectSearchResult(result: ChannelSearchResult) {
  if (!isVodPlatform(result.platform)) return;
  activeSearchIndex.value = -1;
  loadChannel({ platform: result.platform, channel: result.handle || result.channel });
}

function onKeydown(e: KeyboardEvent) {
  const open = searchResults.value.length > 0;
  if (e.key === "Enter") {
    e.preventDefault();
    const selected =
      open && activeSearchIndex.value >= 0 && searchResults.value[activeSearchIndex.value];
    if (selected) selectSearchResult(selected);
    else submit();
    return;
  }
  if (!open) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSearchIndex.value = Math.min(activeSearchIndex.value + 1, searchResults.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSearchIndex.value = Math.max(activeSearchIndex.value - 1, -1);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    clearSearch();
  }
}

function onBlur() {
  setTimeout(() => {
    clearSearch();
    activeSearchIndex.value = -1;
  }, 150);
}

function selectPlatform(p: VodPlatform) {
  if (platform.value === p) return;
  platform.value = p;
  if (loaded.value && query.value) loadChannel({ platform: p, channel: query.value });
}

watch(searchResults, () => {
  activeSearchIndex.value = -1;
});

watch(
  () => [props.open, props.target] as const,
  ([isOpen, target]) => {
    if (!isOpen) {
      clearSearch();
      return;
    }
    failedThumbnails.value.clear();
    if (target) loadChannel(target);
  },
  { immediate: true }
);
</script>

<template>
  <Dialog :open="open" :modal="false" @update:open="emit('update:open', $event)">
    <DialogContent
      class="bg-[#14161a] border-[#262930] w-[95vw] sm:w-[92vw] max-w-xl md:max-w-3xl lg:max-w-5xl max-h-[92vh] flex flex-col overflow-hidden p-4 sm:p-6"
      data-testid="vod-dialog"
    >
      <DialogHeader>
        <DialogTitle class="text-white flex items-center gap-2">
          <Clapperboard class="size-4.5 text-gray-400" aria-hidden="true" />
          {{ t("vods.title") }}
        </DialogTitle>
        <DialogDescription class="text-gray-400">{{ t("vods.description") }}</DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3 flex-1 min-h-0">
        <!-- search row -->
        <div class="flex flex-col sm:flex-row gap-2">
          <div class="flex gap-1.5 shrink-0" role="radiogroup" :aria-label="t('add.platform')">
            <button
              v-for="p in VOD_PLATFORMS"
              :key="p"
              type="button"
              role="radio"
              :aria-checked="platform === p"
              :data-testid="`vod-platform-${p}`"
              class="flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors duration-150 cursor-pointer"
              :class="
                platform === p
                  ? 'bg-white/5 border-white/25 text-white'
                  : 'bg-[#181a1f] border-[#262930] text-gray-400 hover:bg-[#1f2229] hover:border-[#353943] hover:text-white'
              "
              @click="selectPlatform(p)"
            >
              <component
                :is="PLATFORMS[p].icon"
                :size="14"
                :style="{ color: PLATFORMS[p].color }"
              />
              {{ PLATFORMS[p].name }}
            </button>
          </div>

          <div class="relative flex-1 flex items-center">
            <Search
              class="absolute left-3.5 size-4 text-gray-400 pointer-events-none"
              aria-hidden="true"
            />
            <input
              v-model="query"
              data-testid="vod-channel-input"
              type="text"
              autocomplete="off"
              :placeholder="t('vods.channelPlaceholder')"
              :aria-label="t('vods.channelPlaceholder')"
              class="w-full pl-10 pr-3.5 py-2 rounded-lg bg-[#0f1115] text-white border border-[#262930] text-sm transition-colors duration-150 focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20 hover:border-[#353943] placeholder:text-gray-400"
              @input="onInput"
              @keydown="onKeydown"
              @paste="onPaste"
              @blur="onBlur"
            />
            <ChannelSearchDropdown
              :results="searchResults"
              :is-loading="isSearching"
              :active-index="activeSearchIndex"
              @select="selectSearchResult"
              @highlight="activeSearchIndex = $event"
            />
          </div>

          <Button
            :disabled="!query.trim() || isBusy"
            data-testid="vod-search-btn"
            class="bg-white text-[#14161a] font-medium border-transparent hover:bg-gray-200 active:scale-[0.98] transition-colors duration-150 disabled:opacity-35 disabled:cursor-not-allowed"
            @click="submit"
          >
            <Loader2 v-if="isBusy" class="size-4 animate-spin mr-1.5" aria-hidden="true" />
            {{ t("vods.search") }}
          </Button>
        </div>

        <!-- quick channels -->
        <div
          v-if="quickChannels.length"
          class="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            v-for="c in quickChannels"
            :key="`${c.platform}:${c.channel}`"
            type="button"
            class="flex-none inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors duration-150 cursor-pointer"
            :class="
              loaded?.platform === c.platform && loaded.channel === c.channel.toLowerCase()
                ? 'bg-white/10 text-white border-white/20'
                : 'text-gray-400 border-[#2a2d33] bg-[#14161a] hover:text-white hover:border-[#3a3f4b]'
            "
            @click="loadChannel(c)"
          >
            <component
              :is="PLATFORMS[c.platform].icon"
              :size="10"
              :style="{ color: PLATFORMS[c.platform].color }"
            />
            {{ c.label }}
          </button>
        </div>

        <!-- results -->
        <div
          class="border border-[#2a2d33]/60 bg-[#14161a] p-2 rounded-xl flex-1 min-h-[260px] overflow-y-auto scrollbar-thin"
        >
          <div
            v-if="status === 'loading'"
            class="flex flex-col items-center justify-center h-full py-12 text-gray-500 gap-2"
          >
            <Loader2 class="size-5 animate-spin text-gray-400" aria-hidden="true" />
            <span class="text-xs">{{ t("empty.loading") }}</span>
          </div>

          <div
            v-else-if="status === 'error' && !vods.length"
            class="flex items-center justify-center h-full py-12 text-xs text-red-400"
          >
            {{ t(errorKey) }}
          </div>

          <div
            v-else-if="!loaded"
            class="flex flex-col items-center justify-center h-full py-12 text-center text-gray-500 gap-2"
          >
            <Clapperboard class="size-6 text-gray-600" aria-hidden="true" />
            <p class="text-xs max-w-sm">{{ t("vods.hint") }}</p>
          </div>

          <div
            v-else-if="!vods.length"
            class="flex items-center justify-center h-full py-12 text-xs text-gray-500"
          >
            {{ t("vods.empty") }}
          </div>

          <template v-else>
            <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 auto-rows-max">
              <button
                v-for="vod in vods"
                :key="vod.id"
                type="button"
                :data-testid="`vod-card-${vod.id}`"
                :disabled="isAdded(vod)"
                class="group relative flex flex-col w-full rounded-lg bg-[#181a1f] border border-[#262930] hover:border-[#3a3f4b] hover:bg-[#1f2229] transition-all duration-200 cursor-pointer text-left overflow-hidden focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 disabled:cursor-default disabled:hover:border-[#262930]"
                @click="addVod(vod)"
              >
                <div class="relative aspect-video w-full bg-[#0f1115] overflow-hidden">
                  <img
                    v-if="vod.thumbnailUrl && !failedThumbnails.has(vod.id)"
                    :src="vod.thumbnailUrl"
                    class="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-transform duration-300 group-hover:scale-105"
                    alt=""
                    loading="lazy"
                    decoding="async"
                    @error="failedThumbnails.add(vod.id)"
                  />
                  <div v-else class="w-full h-full flex items-center justify-center">
                    <component
                      :is="PLATFORMS[vod.platform].icon"
                      :size="18"
                      :style="{ color: PLATFORMS[vod.platform].color }"
                      class="opacity-30"
                    />
                  </div>

                  <div
                    v-if="vod.isRecording"
                    class="absolute top-1 left-1 flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-600 shadow-xs"
                  >
                    <span class="size-1 rounded-full bg-white animate-pulse" />
                    <span class="text-[8px] font-bold text-white tracking-wide uppercase">{{
                      t("vods.recording")
                    }}</span>
                  </div>

                  <div
                    class="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/75 border border-white/10 text-[9px] font-medium text-white/90 tabular-nums"
                  >
                    {{ formatClock(vod.durationSeconds) }}
                  </div>

                  <div
                    v-if="isAdded(vod)"
                    class="absolute inset-0 bg-black/60 flex items-center justify-center gap-1 text-xs font-medium text-white"
                  >
                    <Check class="size-3.5" aria-hidden="true" />
                    {{ t("vods.added") }}
                  </div>
                </div>

                <div class="p-2 flex flex-col gap-0.5 min-w-0">
                  <p class="text-[11px] font-semibold text-white truncate" :title="vod.title">
                    {{ vod.title || vod.displayName }}
                  </p>
                  <p class="text-[10px] text-gray-400 truncate">
                    {{ formatDate(vod.startedAt) }}
                    <template v-if="vod.viewCount !== undefined">
                      · {{ t("vods.views", { count: formatViews(vod.viewCount) }) }}
                    </template>
                  </p>
                  <p v-if="vod.category" class="text-[10px] text-gray-500 truncate">
                    {{ vod.category }}
                  </p>
                  <p
                    v-if="!isAdded(vod) && overlapsWith(vod)"
                    class="mt-0.5 flex items-center gap-1 text-[10px] text-emerald-300/90 truncate"
                  >
                    <Layers class="size-3 shrink-0" aria-hidden="true" />
                    {{ t("vods.overlaps", { name: overlapsWith(vod) }) }}
                  </p>
                </div>
              </button>
            </div>

            <div class="flex justify-center pt-3 pb-1">
              <Button
                v-if="cursor"
                variant="outline"
                :disabled="status === 'loadingMore'"
                class="border-[#262930] bg-transparent text-gray-300 hover:text-white hover:bg-white/5 hover:border-[#353943]"
                @click="loadMore"
              >
                <Loader2
                  v-if="status === 'loadingMore'"
                  class="size-4 animate-spin mr-1.5"
                  aria-hidden="true"
                />
                {{ t("vods.loadMore") }}
              </Button>
            </div>
          </template>
        </div>

        <p v-if="status === 'error' && vods.length" class="text-xs text-red-400">
          {{ t(errorKey) }}
        </p>
      </div>

      <DialogFooter class="pt-4 border-t border-[#262930]/60">
        <DialogClose as-child>
          <Button
            variant="outline"
            class="border-[#262930] bg-transparent text-gray-400 hover:text-white hover:bg-white/5 hover:border-[#353943] transition-colors duration-150"
          >
            {{ t("common.close") }}
          </Button>
        </DialogClose>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
