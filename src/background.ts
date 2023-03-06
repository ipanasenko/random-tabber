import { getSettings } from './common';

chrome.action.onClicked.addListener(async ({ windowId, id }) => {
  const settings = await getSettings();

  const shouldCloseCurrentTab = settings['close-current'];
  const shouldSearchInCurrentWindowOnly = settings['switch-in'] === 'current';

  const allTabs = await chrome.tabs.query({
    windowId: shouldSearchInCurrentWindowOnly ? windowId : undefined,
  });
  const allOtherTabs = allTabs.filter((tab) => tab.id !== id);
  const randomTab =
    allOtherTabs[Math.floor(Math.random() * allOtherTabs.length)];

  await chrome.tabs.highlight({
    windowId: randomTab.windowId,
    tabs: randomTab.index,
  });

  if (!shouldSearchInCurrentWindowOnly) {
    await chrome.windows.update(randomTab.windowId, { focused: true });
  }

  if (shouldCloseCurrentTab) {
    await chrome.tabs.remove(id);
  }
});
