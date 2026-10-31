<script lang="ts" setup>
import { ref, computed, defineAsyncComponent, watch } from "vue";
import { usePreferences } from "@/composables/usePreferences";
import { useStreams, type Stream } from "@/composables/useStreams";
import { useLiveStatus } from "@/composables/useLiveStatus";
import { useTranscription } from "@/composables/useTranscription";
import { useUnifiedChatState } from "@/composables/useUnifiedChatState";
import { useImmersiveMode } from "@/composables/useImmersiveMode";
import { isTauri } from "@/composables/useUpdater";
const KickChat = defineAsyncComponent(() => import("@/components/chat/KickChat.vue"));
const TwitchChat = defineAsyncComponent(() => import("@/components/chat/TwitchChat.vue"));
const YoutubeChat = defineAsyncComponent(() => import("@/components/chat/YoutubeChat.vue"));
const UnifiedChat = defineAsyncComponent(() => import("@/components/chat/UnifiedChat.vue"));
const TranscriptView = defineAsyncComponent(() => import("@/components/chat/TranscriptView.vue"));
const VodChatReplay = defineAsyncComponent(() => import("@/components/chat/VodChatReplay.vue"));

import { UNIFIED_CHAT_ID } from "@/composables/useUnifiedChat";
import { VOD_CHAT_ID } from "@/composables/useVodChatReplay";
import { KickIcon, TwitchIcon, YoutubeIcon, CustomIcon } from "@/components/icons";

const platformIcons: Record<string, any> = {
  twitch: TwitchIcon,
  kick: KickIcon,
  youtube: YoutubeIcon,
  custom: CustomIcon,
};
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PanelRightClose, Loader2, Clapperboard } from "@lucide/vue";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const sidebarMode = ref<"chat" | "transcript">("chat");

const hasLoadedUnifiedChat = ref(false);
const hasLoadedVodChat = ref(false);
const hasLoadedTranscript = ref(false);

const { streams } = useStreams();
const chatableStreams = computed(() =>
  streams.value.filter((s) => s.platform !== "custom" && !s.vod)
);
const hasVods = computed(() => streams.value.some((s) => s.vod));
const { unifiedChatState } = useUnifiedChatState();
const { selectedChat, sidebarOpen } = usePreferences();

const { immersiveModeEnabled, isRightPanelRevealed, revealRightPanel, scheduleHideRightPanel } =
  useImmersiveMode();

const isSelectOpen = ref(false);

const onPanelMouseEnter = () => {
  if (immersiveModeEnabled.value) {
    revealRightPanel();
  }
};

const onPanelMouseLeave = () => {
  if (immersiveModeEnabled.value && !isSelectOpen.value) {
    scheduleHideRightPanel();
  }
};

watch(
  selectedChat,
  (v) => {
    if (v === UNIFIED_CHAT_ID) hasLoadedUnifiedChat.value = true;
    if (v === VOD_CHAT_ID) hasLoadedVodChat.value = true;
  },
  { immediate: true }
);
watch(
  sidebarMode,
  (v) => {
    if (v === "transcript") hasLoadedTranscript.value = true;
  },
  { immediate: true }
);

watch(
  chatableStreams,
  (available) => {
    const current = selectedChat.value;
    if (current === VOD_CHAT_ID && hasVods.value) return;

    if (available.length === 0) {
      if (hasVods.value) selectedChat.value = VOD_CHAT_ID;
      else if (current !== UNIFIED_CHAT_ID) selectedChat.value = "";
      return;
    }

    const firstAvailable = available[0];
    if (available.length === 1 && current === UNIFIED_CHAT_ID && firstAvailable) {
      selectedChat.value = `${firstAvailable.platform}:${firstAvailable.channel}`;
      return;
    }

    const isValidStream = available.some(
      (s) => `${s.platform}:${s.channel}`.toLowerCase() === current.toLowerCase()
    );
    const isUnified = current === UNIFIED_CHAT_ID;

    if (!isUnified && !isValidStream) {
      if (firstAvailable) {
        selectedChat.value = `${firstAvailable.platform}:${firstAvailable.channel}`;
      } else {
        selectedChat.value = "";
      }
    }
  },
  { immediate: true }
);

// keep the VOD chat selection valid as VODs come and go
watch(hasVods, (has) => {
  if (has && !selectedChat.value) {
    selectedChat.value = VOD_CHAT_ID;
  } else if (!has && selectedChat.value === VOD_CHAT_ID) {
    const first = chatableStreams.value[0];
    selectedChat.value = first ? `${first.platform}:${first.channel}` : "";
  }
});

function isChatSelected(stream: Stream): boolean {
  if (!selectedChat.value) return false;
  return `${stream.platform}:${stream.channel}`.toLowerCase() === selectedChat.value.toLowerCase();
}

const {
  isActive: transcriptionActive,
  isSupported,
  status: transcriptionStatus,
} = useTranscription();

const selectedStreamObj = computed(() =>
  chatableStreams.value.find(
    (s) => `${s.platform}:${s.channel}`.toLowerCase() === selectedChat.value.toLowerCase()
  )
);

const { getStatus } = useLiveStatus();

const getStreamDisplayName = (stream: Stream) => {
  if (stream.platform === "youtube") {
    const status = getStatus(stream.displayName || stream.channel, "youtube");
    const isVideoId = (str?: string) =>
      !!str && !str.startsWith("@") && /^[a-zA-Z0-9_-]{11}$/.test(str);
    const resolvedName =
      (!isVideoId(stream.displayName) ? stream.displayName : undefined) ||
      status?.displayName ||
      (!isVideoId(stream.handle) ? stream.handle : undefined) ||
      status?.handle;

    if (resolvedName) {
      return resolvedName.replace(/^@/, "");
    }
  }
  return stream.displayName || stream.channel;
};
</script>

<template>
  <aside
    :inert="immersiveModeEnabled && !isRightPanelRevealed"
    :class="[
      immersiveModeEnabled
        ? [
            'fixed inset-y-0 right-0 z-50 w-80 bg-[#14161a] border-l border-[#2a2d33] shadow-2xl shadow-black/80 transition-transform duration-250 ease-out',
            isRightPanelRevealed ? 'translate-x-0' : 'translate-x-full pointer-events-none',
          ]
        : [
            'shadow-lg transition-all duration-200 flex flex-col overflow-hidden border-l border-[#2a2d33] bg-[#14161a]',
            sidebarOpen ? 'w-80' : 'w-0',
          ],
    ]"
    @mouseenter="onPanelMouseEnter"
    @mouseleave="onPanelMouseLeave"
  >
    <div
      class="flex flex-col h-full min-w-80"
      :style="{
        opacity: immersiveModeEnabled || sidebarOpen ? 1 : 0,
        transition: immersiveModeEnabled || sidebarOpen ? 'opacity 150ms' : 'opacity 50ms',
      }"
    >
      <!-- stream selector -->
      <div class="px-4 pt-3.5 pb-3.5 border-b border-[#1f2227] flex items-start gap-1.5">
        <TooltipProvider v-if="!immersiveModeEnabled" :delay-duration="300">
          <Tooltip :disable-hoverable-content="true">
            <TooltipTrigger as-child>
              <button
                type="button"
                data-testid="hide-sidebar-btn"
                :aria-label="$t('hide.tooltip')"
                class="shrink-0 h-9 w-7 -ml-2 flex items-center justify-center rounded-md text-gray-400 hover:text-white hover:bg-[#1f2227] transition-colors cursor-pointer"
                @click="sidebarOpen = false"
              >
                <PanelRightClose class="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{{ $t("hide.tooltip") }}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div class="flex-1 min-w-0">
          <Tabs v-if="isTauri() && isSupported" v-model="sidebarMode" class="w-full">
            <TabsList class="grid w-full grid-cols-2 bg-[#1f2227]">
              <TabsTrigger
                value="chat"
                class="data-[state=active]:bg-[#2a2d33] data-[state=active]:text-white text-gray-400"
              >
                {{ $t("chat.tabs.chat") }}
              </TabsTrigger>
              <TabsTrigger
                v-if="isSupported"
                value="transcript"
                class="data-[state=active]:bg-[#2a2d33] data-[state=active]:text-white text-gray-400 flex items-center justify-center gap-1.5"
              >
                <span>{{ $t("chat.tabs.transcript") }}</span>
                <span
                  v-if="transcriptionActive"
                  class="w-3 h-3 flex items-center justify-center shrink-0"
                >
                  <Loader2
                    v-if="transcriptionStatus === 'processing'"
                    class="h-3 w-3 animate-spin text-green-500"
                  />
                  <span
                    v-else
                    class="h-1.5 w-1.5 rounded-full"
                    :class="{
                      'bg-green-500': transcriptionStatus === 'active',
                      'bg-red-400': transcriptionStatus === 'error',
                    }"
                  />
                </span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <div v-show="sidebarMode === 'chat'" :class="isTauri() && isSupported ? 'mt-2.5' : ''">
            <Select
              v-model="selectedChat"
              @update:open="
                (val: boolean) => {
                  isSelectOpen = val;
                  if (!val && immersiveModeEnabled) {
                    scheduleHideRightPanel();
                  }
                }
              "
            >
              <SelectTrigger
                class="w-full bg-[#14161a] text-white border-[#2a2d33] hover:border-[#3a3f4b]"
              >
                <SelectValue :placeholder="$t('chat.selectPlaceholder')">
                  <div v-if="selectedChat === UNIFIED_CHAT_ID" class="flex items-center gap-2">
                    <div class="flex items-center -space-x-1 shrink-0">
                      <component
                        :is="platformIcons[platform]"
                        v-for="platform in unifiedChatState.activePlatforms"
                        :key="platform"
                        class="w-4 h-4"
                        :class="{
                          'text-[#bf94ff]': platform === 'twitch',
                          'text-[#53fc18]': platform === 'kick',
                        }"
                      />
                    </div>
                    <span class="truncate">{{ $t("chat.unified.selectorLabel") }}</span>
                  </div>
                  <div v-else-if="selectedChat === VOD_CHAT_ID" class="flex items-center gap-2">
                    <Clapperboard class="w-4 h-4 shrink-0 text-gray-300" aria-hidden="true" />
                    <span class="truncate">{{ $t("vods.chat.selectorLabel") }}</span>
                  </div>
                  <div v-else-if="selectedStreamObj" class="flex items-center gap-2">
                    <component
                      :is="platformIcons[selectedStreamObj.platform]"
                      class="w-4 h-4 shrink-0"
                    />
                    <span class="truncate">{{ getStreamDisplayName(selectedStreamObj) }}</span>
                  </div>
                  <span v-else>{{ $t("chat.selectPlaceholder") }}</span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent class="bg-[#14161a] border-[#2a2d33]">
                <SelectGroup>
                  <SelectItem
                    v-for="stream in chatableStreams"
                    :key="stream.id"
                    :value="`${stream.platform}:${stream.channel}`"
                    class="text-white focus:bg-[#2a2d33] focus:text-white cursor-pointer"
                  >
                    <div class="flex items-center gap-2">
                      <component :is="platformIcons[stream.platform]" class="w-4 h-4 shrink-0" />
                      <span class="truncate">{{ getStreamDisplayName(stream) }}</span>
                    </div>
                  </SelectItem>
                  <SelectItem
                    v-if="unifiedChatState.showUnifiedChat"
                    :value="UNIFIED_CHAT_ID"
                    class="text-white focus:bg-[#2a2d33] focus:text-white cursor-pointer border-t border-[#2a2d33] mt-1 pt-1"
                  >
                    <div class="flex items-center gap-2">
                      <div class="flex items-center -space-x-1 shrink-0">
                        <component
                          :is="platformIcons[platform]"
                          v-for="platform in unifiedChatState.activePlatforms"
                          :key="platform"
                          class="w-4 h-4"
                          :class="{
                            'text-[#bf94ff]': platform === 'twitch',
                            'text-[#53fc18]': platform === 'kick',
                          }"
                        />
                      </div>
                      <span class="truncate">{{ $t("chat.unified.selectorLabel") }}</span>
                    </div>
                  </SelectItem>
                  <SelectItem
                    v-if="hasVods"
                    :value="VOD_CHAT_ID"
                    data-testid="vod-chat-option"
                    class="text-white focus:bg-[#2a2d33] focus:text-white cursor-pointer border-t border-[#2a2d33] mt-1 pt-1"
                  >
                    <div class="flex items-center gap-2">
                      <Clapperboard class="w-4 h-4 shrink-0 text-gray-300" aria-hidden="true" />
                      <span class="truncate">{{ $t("vods.chat.selectorLabel") }}</span>
                    </div>
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <!-- chat / transcript area -->
      <div id="chat-sidebar-bounds" class="relative flex-1 overflow-hidden flex flex-col">
        <div v-show="sidebarMode === 'chat'" class="absolute inset-0">
          <KickChat
            v-for="stream in chatableStreams.filter((s) => s.platform === 'kick')"
            v-show="isChatSelected(stream)"
            :key="`chat-${stream.id}`"
            :channel="stream.channel"
          />
          <TwitchChat
            v-for="stream in chatableStreams.filter((s) => s.platform === 'twitch')"
            v-show="isChatSelected(stream)"
            :key="`chat-${stream.id}`"
            :channel="stream.channel"
          />
          <YoutubeChat
            v-for="stream in chatableStreams.filter((s) => s.platform === 'youtube')"
            v-show="isChatSelected(stream)"
            :key="`chat-${stream.id}`"
            :channel="stream.channel"
          />
          <UnifiedChat v-if="hasLoadedUnifiedChat" v-show="selectedChat === UNIFIED_CHAT_ID" />
          <VodChatReplay
            v-if="hasLoadedVodChat"
            v-show="selectedChat === VOD_CHAT_ID"
            :active="selectedChat === VOD_CHAT_ID && sidebarMode === 'chat'"
          />
          <div
            v-if="streams.length === 0"
            class="absolute inset-0 flex items-center justify-center text-muted-foreground bg-[#0f1115]"
          >
            <p class="text-center px-4 text-sm text-gray-400">
              {{ $t("chat.noStreams") }}<br />
              <span class="text-xs text-gray-400 mt-1 inline-block">{{
                $t("chat.noStreamsHint")
              }}</span>
            </p>
          </div>
          <div
            v-else-if="!selectedChat"
            class="absolute inset-0 flex items-center justify-center text-muted-foreground bg-[#0f1115]"
          >
            <p class="text-center px-4 text-sm text-gray-400">
              {{ $t("chat.selectPrompt") }}
            </p>
          </div>
        </div>

        <div v-show="sidebarMode === 'transcript' && isSupported" class="absolute inset-0">
          <TranscriptView v-if="hasLoadedTranscript" />
        </div>
      </div>
    </div>
  </aside>
</template>
