import { getSettings } from './common';

const MOVE_TAB_TO_PREV_GROUP_COMMAND = 'move-tab-to-prev-group';
const MOVE_TAB_TO_NEXT_GROUP_COMMAND = 'move-tab-to-next-group';

type MoveGroupCommand =
  | typeof MOVE_TAB_TO_PREV_GROUP_COMMAND
  | typeof MOVE_TAB_TO_NEXT_GROUP_COMMAND;
type Direction = 'prev' | 'next';
type SegmentEdge = 'left' | 'right';

interface TabSegment {
  groupId: number;
  startIndex: number;
  endIndex: number;
}

interface MoveDestination {
  segment: TabSegment;
  edge: SegmentEdge;
}

interface TabMovePlan {
  selectedTabs: chrome.tabs.Tab[];
  selectedTabIds: number[];
  insertionIndex: number;
  destination: MoveDestination;
  shouldUngroupBeforeMove: boolean;
}

const TRANSIENT_TAB_EDIT_ERROR = 'Tabs cannot be edited right now';
const MAX_MOVE_RETRIES = 3;
const TAB_GROUP_ID_NONE = chrome.tabGroups.TAB_GROUP_ID_NONE;

// Commands

function isMoveGroupCommand(command: string): command is MoveGroupCommand {
  return (
    command === MOVE_TAB_TO_PREV_GROUP_COMMAND ||
    command === MOVE_TAB_TO_NEXT_GROUP_COMMAND
  );
}

// Tab and segment helpers

function getTabGroupId(tab: chrome.tabs.Tab) {
  return tab.groupId == null ? TAB_GROUP_ID_NONE : tab.groupId;
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

function getTabSegments(tabs: chrome.tabs.Tab[]): TabSegment[] {
  const sortedTabs = [...tabs].sort((left, right) => left.index - right.index);
  const segments: TabSegment[] = [];

  for (const tab of sortedTabs) {
    const groupId = getTabGroupId(tab);
    const lastSegment = segments[segments.length - 1];

    if (
      lastSegment != null &&
      lastSegment.groupId === groupId &&
      tab.index === lastSegment.endIndex + 1
    ) {
      lastSegment.endIndex = tab.index;
      continue;
    }

    segments.push({
      groupId,
      startIndex: tab.index,
      endIndex: tab.index,
    });
  }

  return segments;
}

function getSegmentIndexForTab(
  segments: TabSegment[],
  anchorTab: chrome.tabs.Tab,
) {
  return segments.findIndex(
    (segment) =>
      segment.startIndex <= anchorTab.index && anchorTab.index <= segment.endIndex,
  );
}

function isExplicitGroupSegment(segment: TabSegment) {
  return segment.groupId !== TAB_GROUP_ID_NONE;
}

function createUngroupedGapDestination(
  boundaryIndex: number,
  edge: SegmentEdge,
): MoveDestination {
  return {
    segment: {
      groupId: TAB_GROUP_ID_NONE,
      startIndex: edge === 'left' ? boundaryIndex : boundaryIndex + 1,
      endIndex: edge === 'left' ? boundaryIndex - 1 : boundaryIndex,
    },
    edge,
  };
}

// Adjacent explicit groups do not jump directly into each other. They first
// expose a synthetic ungrouped destination at the shared boundary.
function getAdjacentSegmentDestination(
  anchorSegment: TabSegment,
  adjacentSegment: TabSegment | undefined,
  adjacentEdge: SegmentEdge,
  gapEdge: SegmentEdge,
) {
  const boundaryIndex =
    gapEdge === 'left' ? anchorSegment.startIndex : anchorSegment.endIndex;

  if (adjacentSegment == null) {
    if (!isExplicitGroupSegment(anchorSegment)) {
      return undefined;
    }

    return createUngroupedGapDestination(boundaryIndex, gapEdge);
  }

  if (
    isExplicitGroupSegment(anchorSegment) &&
    isExplicitGroupSegment(adjacentSegment)
  ) {
    return createUngroupedGapDestination(boundaryIndex, gapEdge);
  }

  return { segment: adjacentSegment, edge: adjacentEdge } satisfies MoveDestination;
}

// Move-planning helpers

function getAnchorMoveDestination(
  segments: TabSegment[],
  anchorTab: chrome.tabs.Tab,
  direction: Direction,
) {
  const anchorSegmentIndex = getSegmentIndexForTab(segments, anchorTab);

  if (anchorSegmentIndex === -1) {
    return undefined;
  }

  const anchorSegment = segments[anchorSegmentIndex];

  if (direction === 'prev') {
    if (anchorTab.index > anchorSegment.startIndex) {
      return { segment: anchorSegment, edge: 'left' } satisfies MoveDestination;
    }

    return getAdjacentSegmentDestination(
      anchorSegment,
      segments[anchorSegmentIndex - 1],
      'right',
      'left',
    );
  }

  if (anchorTab.index < anchorSegment.endIndex) {
    return { segment: anchorSegment, edge: 'right' } satisfies MoveDestination;
  }

  return getAdjacentSegmentDestination(
    anchorSegment,
    segments[anchorSegmentIndex + 1],
    'left',
    'right',
  );
}

function getInsertionIndex(
  tabs: chrome.tabs.Tab[],
  selectedTabIds: Set<number>,
  destination: MoveDestination,
) {
  const sortedTabs = [...tabs].sort((left, right) => left.index - right.index);
  const shouldStayBeforeInsertionPoint =
    destination.edge === 'left'
      ? (tab: chrome.tabs.Tab) => tab.index < destination.segment.startIndex
      : (tab: chrome.tabs.Tab) => tab.index <= destination.segment.endIndex;

  // Chrome reindexes moved tabs within the remaining strip, so compute the
  // insertion point after conceptually removing the current selection first.
  return sortedTabs.filter((tab) => {
    if (tab.id == null || selectedTabIds.has(tab.id)) {
      return false;
    }

    return shouldStayBeforeInsertionPoint(tab);
  }).length;
}

function getSelectedTabIds(selectedTabs: chrome.tabs.Tab[]) {
  return selectedTabs
    .map((tab) => tab.id)
    .filter((tabId): tabId is number => tabId != null);
}

function shouldUngroupSelectionBeforeMove(
  selectedTabs: chrome.tabs.Tab[],
  destination: MoveDestination,
) {
  return selectedTabs.some((tab) => {
    const groupId = getTabGroupId(tab);

    return groupId !== TAB_GROUP_ID_NONE && groupId !== destination.segment.groupId;
  });
}

function shouldApplyDestinationGrouping(
  selectedTabs: chrome.tabs.Tab[],
  destination: MoveDestination,
  didUngroupBeforeMove: boolean,
) {
  if (destination.segment.groupId === TAB_GROUP_ID_NONE && didUngroupBeforeMove) {
    return false;
  }

  if (didUngroupBeforeMove) {
    return true;
  }

  return selectedTabs.some(
    (tab) => getTabGroupId(tab) !== destination.segment.groupId,
  );
}

function createTabMovePlan(
  windowTabs: chrome.tabs.Tab[],
  selectedTabs: chrome.tabs.Tab[],
  direction: Direction,
) {
  if (selectedTabs.length === 0) {
    return undefined;
  }

  const segments = getTabSegments(windowTabs);

  if (segments.length === 0) {
    return undefined;
  }

  const anchorTab =
    direction === 'prev' ? selectedTabs[0] : selectedTabs[selectedTabs.length - 1];
  const destination = getAnchorMoveDestination(segments, anchorTab, direction);

  if (destination == null) {
    return undefined;
  }

  const selectedTabIds = getSelectedTabIds(selectedTabs);

  if (selectedTabIds.length === 0) {
    return undefined;
  }

  return {
    selectedTabs,
    selectedTabIds,
    insertionIndex: getInsertionIndex(
      windowTabs,
      new Set(selectedTabIds),
      destination,
    ),
    destination,
    shouldUngroupBeforeMove: shouldUngroupSelectionBeforeMove(
      selectedTabs,
      destination,
    ),
  } satisfies TabMovePlan;
}

// Tab operations

async function retryTabOperation(
  operation: () => Promise<void>,
  failureMessage: string,
) {
  for (let attempt = 0; attempt <= MAX_MOVE_RETRIES; attempt += 1) {
    try {
      await operation();
      return true;
    } catch (error) {
      const isLastAttempt = attempt === MAX_MOVE_RETRIES;
      const message =
        error instanceof Error ? error.message : String(error ?? '');

      if (!message.includes(TRANSIENT_TAB_EDIT_ERROR) || isLastAttempt) {
        console.error(failureMessage, error);
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return false;
}

async function moveTabsToIndex(tabIds: number[], index: number) {
  return retryTabOperation(
    async () => {
      await chrome.tabs.move(tabIds, { index });
    },
    'Failed to move tabs',
  );
}

async function ungroupTabs(tabIds: number[]) {
  return retryTabOperation(
    async () => {
      await chrome.tabs.ungroup(tabIds);
    },
    'Failed to ungroup tabs',
  );
}

async function moveTabsToSegment(tabIds: number[], destination: MoveDestination) {
  if (destination.segment.groupId === TAB_GROUP_ID_NONE) {
    return ungroupTabs(tabIds);
  }

  return retryTabOperation(
    async () => {
      await chrome.tabs.group({ groupId: destination.segment.groupId, tabIds });
    },
    'Failed to move tabs to group',
  );
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
  const movePlan = createTabMovePlan(windowTabs, selectedTabs, direction);

  if (movePlan == null) {
    return;
  }

  if (movePlan.shouldUngroupBeforeMove) {
    const didUngroup = await ungroupTabs(movePlan.selectedTabIds);

    if (!didUngroup) {
      return;
    }
  }

  const didMove = await moveTabsToIndex(
    movePlan.selectedTabIds,
    movePlan.insertionIndex,
  );

  if (!didMove) {
    return;
  }

  if (
    !shouldApplyDestinationGrouping(
      movePlan.selectedTabs,
      movePlan.destination,
      movePlan.shouldUngroupBeforeMove,
    )
  ) {
    return;
  }

  await moveTabsToSegment(movePlan.selectedTabIds, movePlan.destination);
}

// Command handlers

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
