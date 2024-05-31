import { defineInterface } from '@directus/extensions-sdk'
import OptionsComponent from './options.vue'
import { ComponentOptions } from 'vue'

export default defineInterface({
  id: 'search-configuration',
  name: 'Configure Search',
  icon: 'search',
  description:
    'Override the Directus internal search system with a custom search filter - supports relationships.',
  component: () => null,
  options: OptionsComponent as ComponentOptions,
  hideLabel: true,
  hideLoader: true,
  types: ['alias'],
  localTypes: ['presentation'],
  group: 'presentation',
})
