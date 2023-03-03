chrome.action.onClicked.addListener(async ({ windowId, id }) => {
  const allTabs = await chrome.tabs.query({ windowId });
  const allOtherTabs = allTabs.filter((tab) => tab.id !== id);
  const randomTab =
    allOtherTabs[Math.floor(Math.random() * allOtherTabs.length)];

  await chrome.tabs.highlight({ tabs: randomTab.index });
});
