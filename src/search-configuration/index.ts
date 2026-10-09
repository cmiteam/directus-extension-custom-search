import { defineInterface } from '@directus/extensions-sdk'
import OptionsComponent from './options.vue'

export default defineInterface({
  id: 'search-configuration',
  name: 'Configure Search',
  icon: 'search',
  description:
    'Override the Directus internal search system with a custom search filter - supports relationships.',
  component: () => null,
  // @ts-expect-error Directus types this as Exclude<ComponentOptions, any>, which is never, but the app accepts an options component
  options: OptionsComponent,
  hideLabel: true,
  hideLoader: true,
  types: ['alias'],
  localTypes: ['presentation'],
  group: 'presentation',
})
