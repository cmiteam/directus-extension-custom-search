<template>
  <v-form
    :modelValue="value"
    @update:modelValue="emit('input', $event)"
    :fields="[
      {
        field: 'search_config',
        name: 'Search Config',
        type: 'json',
        meta: {
          interface: 'system-filter',
          note: '$SEARCH will be replaced by the current search string',
          options: {
            collectionName: collection,
            collectionRequired: true,
          },
        },
      },
    ]"
  >
  </v-form>
</template>

<script setup lang="ts">
defineProps<{ value: any; collection: string }>();
const emit = defineEmits(['input']);
</script>
