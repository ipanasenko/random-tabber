interface Settings {
  'switch-in': 'current' | 'all';
  'close-current': boolean;
}

const defaultSettings: Settings = {
  'switch-in': 'current',
  'close-current': false,
};
export const getSettings = async (): Promise<Settings> =>
  (await chrome.storage.sync.get(defaultSettings)) as Settings;
