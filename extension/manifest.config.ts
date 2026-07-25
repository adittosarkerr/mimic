import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Mimic — Web Task Recorder',
  version: '0.2.0',
  description: 'Record any website task once, replay it with new inputs.',
  action: {
    default_popup: 'src/popup/index.html',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: ['activeTab', 'scripting', 'storage', 'tabs', 'webNavigation', 'debugger'],
  host_permissions: ['<all_urls>'],
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/recorder.ts'],
      all_frames: true,
      match_about_blank: true,
      run_at: 'document_start',
    },
  ],
})
