<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 })
const paths: Record<string, string> = {
  terminal: 'm5 7 5 5-5 5 M13 17h6', grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  search: 'm21 21-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', plus: 'M12 5v14 M5 12h14',
  folder: 'M3 7V5h7l2 3h9v12H3z', clock: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6', play: 'M7 5v14l12-7z', stop: 'M6 6h12v12H6z',
  code: 'm8 7-5 5 5 5 m8-10 5 5-5 5 m-3-14-2 18', down: 'm6 9 6 6 6-6', close: 'm6 6 12 12 M6 18 18 6',
  check: 'm5 12 4 4L19 6', copy: 'M9 9h12v12H9z M15 5V3H3v12h2', book: 'M4 3h16v18H4z M8 7h8 M8 11h8',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7', refresh: 'M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 13-3l2 3 M19 16a8 8 0 0 1-13 3l-2-3',
  menu: 'M4 6h16 M4 12h16 M4 18h16', warning: 'm12 3 10 18H2z M12 9v5 M12 17h.01', arrow: 'm8 5 7 7-7 7',
}
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.code" /></svg></template>
