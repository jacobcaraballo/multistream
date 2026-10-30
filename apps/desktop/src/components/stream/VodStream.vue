<script setup lang="ts">
import { computed } from "vue";
import BaseStream from "./BaseStream.vue";
import VodPlayer from "./VodPlayer.vue";
import { useStreams } from "@/composables/useStreams";
import { useProfilePicture } from "@/composables/useProfilePicture";
import { useFocusedStream } from "@/composables/useFocusedStream";
import type { Vod } from "@/lib/vod";

const props = defineProps<{ channelid: string; vod: Vod }>();

const { streams } = useStreams();
const { getProfilePicture } = useProfilePicture();
const { isFocused } = useFocusedStream();

// the grid keeps a snapshot of each stream; read the live entry so recording status updates flow in
const currentVod = computed(
  () => streams.value.find((s) => s.id === props.channelid)?.vod ?? props.vod
);
const profilePicture = getProfilePicture(props.vod.channel, props.vod.platform);
</script>

<template>
  <BaseStream
    :channelid="channelid"
    :channel="currentVod.channel"
    :platform="currentVod.platform"
    :display-name="currentVod.displayName"
    is-vod
  >
    <VodPlayer
      :key="`${currentVod.platform}:${currentVod.id}`"
      :stream-id="channelid"
      :vod="currentVod"
      :avatar-url="profilePicture"
      :is-focused="isFocused(channelid)"
    />
  </BaseStream>
</template>
