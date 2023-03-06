import { getSettings } from './options';

chrome.action.onClicked.addListener(async ({ windowId, id }) => {
  const settings = await getSettings();

  const allTabs = await chrome.tabs.query({ windowId });
  const allOtherTabs = allTabs.filter((tab) => tab.id !== id);
  const randomTab =
    allOtherTabs[Math.floor(Math.random() * allOtherTabs.length)];

  await chrome.tabs.highlight({
    windowId: randomTab.windowId,
    tabs: randomTab.index,
  });

  if (settings['close-current']) {
    await chrome.tabs.remove(id);
  }
});
