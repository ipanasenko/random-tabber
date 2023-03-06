import { getSettings } from './common';

async function saveOptions() {
  (document.getElementById('save') as HTMLButtonElement).innerText =
    'Saving...';

  const switchIn = (document.getElementById('switch-in') as HTMLSelectElement)
    .value;
  const closeCurrent = (
    document.getElementById('close-current') as HTMLInputElement
  ).checked;

  await chrome.storage.sync.set({
    'switch-in': switchIn,
    'close-current': closeCurrent,
  });

  (document.getElementById('save') as HTMLButtonElement).innerText = 'Saved!';
}

async function restoreOptions() {
  const settings = await getSettings();

  (document.getElementById('switch-in') as HTMLSelectElement).value =
    settings['switch-in'];
  (document.getElementById('close-current') as HTMLInputElement).checked =
    settings['close-current'];

  (document.getElementById('loaded') as HTMLDivElement).style.display = 'block';
  (document.getElementById('loading') as HTMLDivElement).style.display = 'none';
}

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
