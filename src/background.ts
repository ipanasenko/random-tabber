import { getSettings } from './common';

const MOVE_TAB_TO_PREV_GROUP_COMMAND = 'move-tab-to-prev-group';
const MOVE_TAB_TO_NEXT_GROUP_COMMAND = 'move-tab-to-next-group';

type MoveGroupCommand =
  | typeof MOVE_TAB_TO_PREV_GROUP_COMMAND
  | typeof MOVE_TAB_TO_NEXT_GROUP_COMMAND;
type Direction = 'prev' | 'next';

interface GroupSegment {
  groupId: number;
  startIndex: number;
  endIndex: number;
}

const TRANSIENT_TAB_EDIT_ERROR = 'Tabs cannot be edited right now';
const MAX_MOVE_RETRIES = 3;
const TAB_GROUP_ID_NONE = chrome.tabGroups.TAB_GROUP_ID_NONE;

function isMoveGroupCommand(command: string): command is MoveGroupCommand {
  return (
    command === MOVE_TAB_TO_PREV_GROUP_COMMAND ||
    command === MOVE_TAB_TO_NEXT_GROUP_COMMAND
  );
}

async function getActiveTab() {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  return activeTab;
}

async function getSelectedTabs(windowId: number, activeTabId: number) {
  const highlightedTabs = await chrome.tabs.query({
    windowId,
    highlighted: true,
  });

  if (highlightedTabs.length > 0) {
    return highlightedTabs.sort((left, right) => left.index - right.index);
  }

  const activeTab = await chrome.tabs.get(activeTabId);

  return [activeTab];
}

function getGroupedSegments(tabs: chrome.tabs.Tab[]): GroupSegment[] {
  const sortedTabs = [...tabs].sort((left, right) => left.index - right.index);
  const groupedSegments: GroupSegment[] = [];

  for (const tab of sortedTabs) {
    if (tab.groupId == null || tab.groupId === TAB_GROUP_ID_NONE) {
      continue;
    }

    const lastSegment = groupedSegments[groupedSegments.length - 1];

    if (
      lastSegment != null &&
      lastSegment.groupId === tab.groupId &&
      tab.index === lastSegment.endIndex + 1
    ) {
      lastSegment.endIndex = tab.index;
      continue;
    }

    groupedSegments.push({
      groupId: tab.groupId,
      startIndex: tab.index,
      endIndex: tab.index,
    });
  }

  return groupedSegments;
}

function getDestinationGroupId(
  groupedSegments: GroupSegment[],
  anchorTab: chrome.tabs.Tab,
  direction: Direction,
) {
  if (anchorTab.groupId != null && anchorTab.groupId !== TAB_GROUP_ID_NONE) {
    const anchorGroupIndex = groupedSegments.findIndex(
      (segment) => segment.groupId === anchorTab.groupId,
    );

    if (anchorGroupIndex === -1) {
      return undefined;
    }

    const offset = direction === 'prev' ? -1 : 1;

    return groupedSegments[anchorGroupIndex + offset]?.groupId;
  }

  if (direction === 'prev') {
    for (let index = groupedSegments.length - 1; index >= 0; index -= 1) {
      const segment = groupedSegments[index];

      if (segment.endIndex < anchorTab.index) {
        return segment.groupId;
      }
    }

    return undefined;
  }

  return groupedSegments.find((segment) => segment.startIndex > anchorTab.index)
    ?.groupId;
}

async function retryGroupMove(tabIds: number[], groupId: number) {
  for (let attempt = 0; attempt <= MAX_MOVE_RETRIES; attempt += 1) {
    try {
      await chrome.tabs.group({ groupId, tabIds });
      return;
    } catch (error) {
      const isLastAttempt = attempt === MAX_MOVE_RETRIES;
      const message =
        error instanceof Error ? error.message : String(error ?? '');

      if (!message.includes(TRANSIENT_TAB_EDIT_ERROR) || isLastAttempt) {
        console.error('Failed to move tabs to group', error);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function moveSelectedTabsToAdjacentGroup(direction: Direction) {
  const activeTab = await getActiveTab();

  if (activeTab?.id == null || activeTab.windowId == null) {
    return;
  }

  const [windowTabs, selectedTabs] = await Promise.all([
    chrome.tabs.query({ windowId: activeTab.windowId }),
    getSelectedTabs(activeTab.windowId, activeTab.id),
  ]);
  const groupedSegments = getGroupedSegments(windowTabs);

  if (groupedSegments.length === 0 || selectedTabs.length === 0) {
    return;
  }

  const anchorTab =
    direction === 'prev' ? selectedTabs[0] : selectedTabs[selectedTabs.length - 1];
  const destinationGroupId = getDestinationGroupId(
    groupedSegments,
    anchorTab,
    direction,
  );

  if (destinationGroupId == null) {
    return;
  }

  const selectedTabIds = selectedTabs
    .map((tab) => tab.id)
    .filter((tabId): tabId is number => tabId != null);

  if (selectedTabIds.length === 0) {
    return;
  }

  await retryGroupMove(selectedTabIds, destinationGroupId);
}

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

chrome.commands.onCommand.addListener(async (command) => {
  if (!isMoveGroupCommand(command)) {
    return;
  }

  const direction = command === MOVE_TAB_TO_PREV_GROUP_COMMAND ? 'prev' : 'next';

  await moveSelectedTabsToAdjacentGroup(direction);
});
