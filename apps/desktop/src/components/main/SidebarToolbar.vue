<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { UserPlus2, Settings, Maximize2, Minimize2, Clapperboard } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useImmersiveMode } from "@/composables/useImmersiveMode";

// expanded: a row of buttons with the version underneath; collapsed: one icon column
const props = defineProps<{ expanded: boolean }>();

const { t } = useI18n();
const { immersiveModeEnabled, toggleImmersiveMode } = useImmersiveMode();

const appVersion = import.meta.env.VITE_APP_VERSION;
const tooltipSide = computed(() => (props.expanded ? "top" : "right"));

const showDialog = (detail: string) =>
  window.dispatchEvent(new CustomEvent("multistream-show-dialog", { detail }));

const openVods = () => window.dispatchEvent(new CustomEvent("multistream-open-vods"));

const buttonClass =
  "group aspect-square h-auto w-full p-0 flex items-center justify-center rounded-xl border-[#2a2d33] bg-[#14161a] hover:bg-[#1c1f24] hover:border-[#3a3f4b] transition-all duration-200";
</script>

<template>
  <div class="shrink-0 border-t border-[#1f2227] px-2 py-2.5" data-testid="sidebar-toolbar">
    <TooltipProvider :delay-duration="0" :disable-hoverable-content="true">
      <div class="grid" :class="expanded ? 'grid-cols-4 gap-2' : 'grid-cols-1 gap-1.5'">
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              data-testid="add-stream-btn"
              :aria-label="t('add.tooltip')"
              :class="buttonClass"
              variant="outline"
              @click="showDialog('add-stream')"
            >
              <UserPlus2
                class="size-4.5 text-white transition-transform duration-300 group-hover:scale-110"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent :side="tooltipSide">
            <p>{{ t("add.tooltip") }}</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              data-testid="vods-btn"
              :aria-label="t('vods.tooltip')"
              :class="buttonClass"
              variant="outline"
              @click="openVods"
            >
              <Clapperboard
                class="size-4.5 text-white transition-transform duration-300 group-hover:scale-110"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent :side="tooltipSide">
            <p>{{ t("vods.tooltip") }}</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              data-testid="settings-btn"
              :aria-label="t('settings.title')"
              :class="buttonClass"
              variant="outline"
              @click="showDialog('settings')"
            >
              <Settings
                class="size-4.5 text-white transition-transform duration-300 group-hover:rotate-90"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent :side="tooltipSide">
            <p>{{ t("settings.title") }}</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              data-testid="immersive-mode-btn"
              :aria-label="
                immersiveModeEnabled ? t('immersive.exitTooltip') : t('immersive.tooltip')
              "
              :class="buttonClass"
              variant="outline"
              @click="toggleImmersiveMode"
            >
              <component
                :is="immersiveModeEnabled ? Minimize2 : Maximize2"
                class="size-4.5 text-white transition-transform duration-300 group-hover:scale-110"
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent :side="tooltipSide">
            <p>
              {{ immersiveModeEnabled ? t("immersive.exitTooltip") : t("immersive.tooltip") }}
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>

    <div v-if="expanded && appVersion" class="mt-2.5 flex items-center justify-center gap-3">
      <div class="h-px flex-1 bg-linear-to-r from-transparent to-[#2a2d33]" />
      <button
        type="button"
        class="text-[10px] font-semibold tracking-widest uppercase text-gray-400 hover:text-gray-200 transition-colors duration-200 select-none cursor-default"
        @click="showDialog('changelog')"
      >
        v{{ appVersion }}
      </button>
      <div class="h-px flex-1 bg-linear-to-l from-transparent to-[#2a2d33]" />
    </div>
  </div>
</template>
