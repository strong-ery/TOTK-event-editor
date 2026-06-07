let graph;
let widget;
let eventNamesVisible = false;
let eventParamVisible = false;
let eventMessagesVisible = false;
let actionsProhibited = false;
let isDeleting = false;
let suppressNextViewportAdjustment = false;
let hasHiddenEntryPoints = false;
let resetViewportOnNextLoad = false;
let preservedViewport = null;
let preservedFocusNodeId = null;
let preservedFocusPoint = null;
const GRAPH_TRANSITION_MS = 500;
let pendingLoadFinalizeToken = 0;
let nextGraphTransitionMs = GRAPH_TRANSITION_MS;
let graphSearchQuery = '';
let graphSearchCaseInsensitive = true;
let graphSearchMatches = [];
let graphSearchIndex = -1;
const LABEL_WRAP_LENGTH = 44;
const MESSAGE_WRAP_LENGTH = 62;
const MESSAGE_SEPARATOR = '-'.repeat(30);
const MESSAGE_TAG_REGEX = /(\{\{[^{}\n]+\}\})/g;

const WHITELISTED_PARAMS = new Set(['MessageId', 'ASName']);

function isMultiSelectEvent(event) {
  return !!(event && (event.ctrlKey || event.metaKey));
}

function formatNodeParamValue(value) {
  return typeof value === 'number' ? value.toFixed(6).replace(/\.?0*$/, '') : `${value}`;
}

function normalizeMessageText(text) {
  const normalized = `${text}`.replace(/\r\n/g, '\n').trim();
  const paragraphs = normalized
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph
      .replace(/\s*\n\s*/g, ' ')
      .replace(/([.!?…])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.join('\n\n');
}

function wrapLabelText(text, maxLength=LABEL_WRAP_LENGTH) {
  const normalized = `${text}`.replace(/\r\n/g, '\n');
  const wrappedLines = [];
  for (const sourceLine of normalized.split('\n')) {
    const line = sourceLine.trim();
    if (!line) {
      wrappedLines.push('');
      continue;
    }

    let current = '';
    let previousWord = '';
    const words = line.match(/\{\{[^{}\n]+\}\}|[^\s]+/g) || [];
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      const startsNewSentence = index > 0 && /[.!?…]["')\]]*$/.test(previousWord);
      if (startsNewSentence && current) {
        let fittingSentenceWords = 0;
        let probe = current;
        for (let lookahead = index; lookahead < words.length; lookahead++) {
          const lookaheadCandidate = `${probe} ${words[lookahead]}`;
          if (lookaheadCandidate.length > maxLength) {
            break;
          }
          fittingSentenceWords += 1;
          probe = lookaheadCandidate;
        }
        if (fittingSentenceWords > 0 && fittingSentenceWords <= 4) {
          wrappedLines.push(current);
          current = '';
        }
      }

      if (!current) {
        const isTagToken = /^\{\{[^{}\n]+\}\}$/.test(word);
        if (isTagToken || word.length <= maxLength) {
          current = word;
        } else {
          for (let i = 0; i < word.length; i += maxLength) {
            wrappedLines.push(word.slice(i, i + maxLength));
          }
        }
        previousWord = word;
        continue;
      }

      const candidate = `${current} ${word}`;
      if (candidate.length <= maxLength) {
        current = candidate;
      } else {
        const currentWords = current.split(/\s+/);
        const trailingWord = currentWords[currentWords.length - 1] || '';
        const canKeepPairTogether = !startsNewSentence
          && trailingWord.length > 0 && trailingWord.length <= 2
          && `${trailingWord} ${word}`.length <= maxLength
          && currentWords.length > 1;
        const punctuationIndex = currentWords.findIndex((entry) => /(?:,|;|:|\.{3}|…)$/.test(entry));
        const punctuationTail = punctuationIndex >= 0 ? currentWords.slice(punctuationIndex + 1) : [];
        const shouldBreakAfterPunctuation = punctuationIndex >= 0
          && punctuationTail.length > 0
          && punctuationTail.length <= 2;
        if (shouldBreakAfterPunctuation) {
          const previousLine = currentWords.slice(0, punctuationIndex + 1).join(' ');
          if (previousLine) {
            wrappedLines.push(previousLine);
          }
          current = punctuationTail.join(' ');
        } else if (canKeepPairTogether) {
          const previousLine = currentWords.slice(0, -1).join(' ');
          if (previousLine) {
            wrappedLines.push(previousLine);
          }
          current = `${trailingWord} ${word}`;
        } else {
          wrappedLines.push(current);
          const isTagToken = /^\{\{[^{}\n]+\}\}$/.test(word);
          if (isTagToken || word.length <= maxLength) {
            current = word;
          } else {
            for (let i = 0; i < word.length; i += maxLength) {
              wrappedLines.push(word.slice(i, i + maxLength));
            }
            current = '';
          }
        }
      }
      previousWord = word;
    }

    if (current) {
      wrappedLines.push(current);
    }
  }
  return wrappedLines;
}

function appendWrappedLabelLine(label, prefix, text) {
  const wrapped = wrapLabelText(text);
  if (!wrapped.length) {
    return `${label}\n${prefix}`;
  }
  let nextLabel = `${label}\n${prefix}${wrapped[0]}`;
  for (const continuation of wrapped.slice(1)) {
    nextLabel += `\n${continuation}`;
  }
  return nextLabel;
}

function appendMessageBlock(label, text) {
  const wrapped = wrapLabelText(text, MESSAGE_WRAP_LENGTH);
  if (!wrapped.length) {
    return label;
  }

  let nextLabel = `${label}\n\n${MESSAGE_SEPARATOR}\n`;
  for (const line of wrapped) {
    nextLabel += `\n${line}`;
  }
  nextLabel += `\n\n${MESSAGE_SEPARATOR}\n`;
  return nextLabel;
}

function getElementCenterInViewport(element) {
  if (!element || !element.node()) {
    return null;
  }
  const rect = element.node().getBoundingClientRect();
  return {
    x: rect.left + (rect.width / 2),
    y: rect.top + (rect.height / 2),
  };
}

function rerenderAroundCurrentNode(preferredNodeId) {
  const currentViewport = graph.renderer.getViewport();
  const targetNodeId = preferredNodeId != null ? preferredNodeId : graph.renderer.getSelection();
  graph.refresh();
  graph.render(0);
  setTimeout(() => {
    if (targetNodeId != null && targetNodeId !== -1 && graph.renderer.getElement(targetNodeId)) {
      graph.renderer.scrollTo(targetNodeId, true, 0);
    } else {
      graph.renderer.restoreViewport(currentViewport);
    }
  }, 20);
}

function getMessageText(node) {
  if (!node || !node.data || typeof node.data._message_text !== 'string') {
    return '';
  }
  return normalizeMessageText(node.data._message_text);
}

function getChoiceLabelText(node, key) {
  if (!node || !node.data || !node.data._choice_label_texts) {
    return '';
  }
  const text = node.data._choice_label_texts[key];
  return typeof text === 'string' ? normalizeMessageText(text) : '';
}

function getNodeLabel(node) {
  const prefix = eventNamesVisible ? `${node.data.name}\n` : '';
  let label = `${node.id}`;

  if (node.node_type === 'entry') {
    label = `${node.data.name}`;
  }
  else if (node.node_type === 'action') {
    label = `${prefix}${node.data.actor}\n${node.data.action}`;
  }
  else if (node.node_type === 'switch') {
    label = `${prefix}${node.data.actor}\n${node.data.query}`;
  }
  else if (node.node_type === 'fork') {
    label = `${prefix}Fork`;
  }
  else if (node.node_type === 'join') {
    label = `${prefix}Join`;
  }
  else if (node.node_type === 'sub_flow') {
    label = `${prefix}${node.data.res_flowchart_name}\n<${node.data.entry_point_name}>`;
  }

  if (eventParamVisible && node.data.params) {
    for (const [key, value] of Object.entries(node.data.params)) {
      if (key === 'IsWaitFinish') {
        continue;
      }
      label = appendWrappedLabelLine(label, `${key}: `, formatNodeParamValue(value));
      if (key === 'MessageId' && eventMessagesVisible) {
        const messageText = getMessageText(node);
        if (messageText) {
          label = appendMessageBlock(label, messageText);
        }
      } else if (eventMessagesVisible && key.startsWith('ChoiceLabel')) {
        const choiceText = getChoiceLabelText(node, key);
        if (choiceText) {
          label = appendMessageBlock(label, choiceText);
        }
      }
    }
  }
  else if (eventMessagesVisible && node.data && node.data.params && node.data.params.MessageId) {
    label = appendWrappedLabelLine(label, 'MessageId: ', formatNodeParamValue(node.data.params.MessageId));
    const messageText = getMessageText(node);
    if (messageText) {
      label = appendMessageBlock(label, messageText);
    }
  }
  return label;
}

function handleNodeContextMenu(id) {
  const actions = [];
  const selectedNodeIds = graph.renderer.getSelectedIds();
  const selectedCount = selectedNodeIds.length;

  const idx = parseInt(id, 10);
  const node = graph.g.node(id);
  const prevNodes = [...(new Set(graph.g.inEdges(id).filter(e => !graph.g.edge(e).virtual).map(e => parseInt(e.v, 10))))];
  const nextNodes = [...(new Set(graph.g.outEdges(id).filter(e => !graph.g.edge(e).virtual).map(e => parseInt(e.w, 10))))];
  const classes = node.class.split(' ');

  const addAction = (name, fn) => actions.push({ title: name, action: () => { setTimeout(fn, 60) } });
  const clearSelectionForDelete = () => {
    graph.renderer.clearSelectionWithoutEmittingSignal();
    widget.emitEventSelectedSignal(-1);
  };

  if (!actionsProhibited) {
    if (selectedCount) {
      addAction(selectedCount > 1 ? `Copy selected nodes (${selectedCount})` : 'Copy selected node', () => widget.copyEvents(selectedNodeIds));
      if (selectedCount > 1) {
        addAction(`Delete selected nodes (${selectedCount})`, () => {
          clearSelectionForDelete();
          isDeleting = true;
          widget.removeEvents(selectedNodeIds);
        });
      } else if (selectedNodeIds[0] !== idx) {
        addAction('Delete selected node', () => {
          clearSelectionForDelete();
          isDeleting = true;
          widget.removeEvents(selectedNodeIds);
        });
      }
      actions.push({ divider: true });
    }

    addAction('Paste copied events', () => widget.pasteEventsInto(idx));
    actions.push({ divider: true });

    if (idx >= 0) { // Event actions
      addAction('Add fork...', () => widget.addForkAt(idx));
      actions.push({ divider: true });

      if (!classes.includes('fork') && !classes.includes('join')) {
        addAction('Edit event...', () => widget.editEvent(idx));
      }
      if (classes.includes('switch')) {
        addAction('Edit cases...', () => widget.editSwitchBranches(idx));
      }
      if (classes.includes('fork')) {
        addAction('Edit branches...', () => widget.editForkBranches(idx));
      }
      if (!classes.includes('join')) {
        actions.push({ divider: true });
      }

      addAction('Add entry point here...', () => widget.addEntryPoint(idx));
      actions.push({ divider: true });

      if (!classes.includes('join')) {
        addAction('Add new parent...', () => widget.addEventAbove(prevNodes, idx));
      }

      if (classes.includes('action') || classes.includes('sub_flow') || classes.includes('join')) {
        addAction('Add new child...', () => widget.addEventBelow(idx));
        if (nextNodes.length) {
          addAction('Unlink child', () => widget.unlink(idx));
        } else {
          addAction('Link to event...', () => widget.link(idx));
        }
      }

      const oneBranchSwitchOrFork =
          nextNodes.length <= 1 && (classes.includes('fork') || classes.includes('switch'));
      const isOnlyEventInEntry =
          nextNodes.length === 0 && prevNodes.length === 1 && parseInt(prevNodes[0], 10) <= -1000;

      if (!isOnlyEventInEntry && (classes.includes('action') || classes.includes('sub_flow') || oneBranchSwitchOrFork)) {
        actions.push({ divider: true });
        addAction('Delete event', () => {
          clearSelectionForDelete();
          isDeleting = true;
          widget.removeEvent(prevNodes, idx);
        });
      }

    } else { // Entry point actions
      addAction('Add new child...', () => widget.addEntryPointChild(idx));
      actions.push({ divider: true });
      addAction('Delete entry point', () => widget.removeEntryPoint(idx));
    }

    actions.push({ divider: true });
  }

  addAction('Select connected events', () => graph.selectConnected(id));
  if (hasHiddenEntryPoints) {
    addAction('Show all events', () => widget.showAllEventsFromNode(idx));
  } else {
    addAction('Show only connected events', () => widget.showOnlyConnectedEvents(idx));
  }

  return actions;
}

function handleBackgroundContextMenu() {
  const actions = [];
  const selectedNodeIds = graph.renderer.getSelectedIds();
  const selectedCount = selectedNodeIds.length;
  const addAction = (name, fn) => actions.push({ title: name, action: () => { setTimeout(fn, 60) } });
  const clearSelectionForDelete = () => {
    graph.renderer.clearSelectionWithoutEmittingSignal();
    widget.emitEventSelectedSignal(-1);
  };

  if (!actionsProhibited) {
    addAction('Add event...', () => widget.addStandaloneEvent());
    addAction('Add fork...', () => widget.addFork());
    actions.push({ divider: true });

    if (selectedCount) {
      addAction(selectedCount > 1 ? `Copy selected nodes (${selectedCount})` : 'Copy selected node', () => widget.copyEvents(selectedNodeIds));
      addAction(selectedCount > 1 ? `Delete selected nodes (${selectedCount})` : 'Delete selected node', () => {
        clearSelectionForDelete();
        isDeleting = true;
        widget.removeEvents(selectedNodeIds);
      });
      actions.push({ divider: true });
    }
    addAction('Paste copied events', () => widget.pasteEvents());
    actions.push({ divider: true });
  }

  if (hasHiddenEntryPoints) {
    addAction('Show all events', () => widget.showAllEvents());
  }

  return actions;
}

function clampContextMenuToViewport() {
  const menuNode = d3.select('.d3-context-menu').node();
  if (!menuNode) {
    return;
  }
  const rect = menuNode.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
  const left = Math.max(8, Math.min(rect.left, maxLeft));
  const top = Math.max(8, Math.min(rect.top, maxTop));
  d3.select('.d3-context-menu')
    .style('left', `${left}px`)
    .style('top', `${top}px`);
}

class Renderer {
  constructor() {
    this.svg = d3.select('svg');
    this.svgGroup = d3.select('svg g');
    this.selectedNodeIds = new Set();
    this.primarySelectedId = null;

    this.nodeWhitelist = null;

    this.zoom = d3.behavior.zoom();
    this.lastZoomEventStart = null;
    this.svg.call(this.zoom.on('zoom', () => this.updateTransform()));
    this.svg.call(this.zoom.on('zoomstart', () => this.lastZoomEventStart = new Date()));

    // Reset selection on click.
    // Unfortunately we need to do some extra work to determine whether the click event is caused
    // by zooming or is a simple click.
    this.svg.on('click', () => {
      // The zoom lasted more than 100 ms, so it's likely a zoom.
      if ((new Date() - this.lastZoomEventStart) >= 100) {
        return;
      }
      this.clearSelection();
    });
    this.svg.on('contextmenu', () => {
      if (this._isTargetInsideNode(d3.event.target)) {
        return;
      }
      d3.contextMenu(handleBackgroundContextMenu).call(this.svg.node());
      clampContextMenuToViewport();
    });
  }

  _styleMessageTags() {
    this.svgGroup.selectAll('.node .label text').each(function() {
      const textNode = this;
      const tspans = textNode.querySelectorAll('tspan');
      tspans.forEach((lineTspan) => {
        const line = lineTspan.textContent || '';
        if (!MESSAGE_TAG_REGEX.test(line)) {
          MESSAGE_TAG_REGEX.lastIndex = 0;
          return;
        }
        MESSAGE_TAG_REGEX.lastIndex = 0;
        const parts = line.split(MESSAGE_TAG_REGEX).filter((part) => part.length > 0);
        while (lineTspan.firstChild) {
          lineTspan.removeChild(lineTspan.firstChild);
        }
        for (const part of parts) {
          const segment = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
          segment.textContent = part;
          if (/^\{\{[^{}\n]+\}\}$/.test(part)) {
            segment.setAttribute('class', 'message-tag');
            segment.setAttribute('fill', '#b8bcc4');
          }
          lineTspan.appendChild(segment);
        }
      });
    });
  }

  getSelection() {
    const selectedIds = this.getSelectedIds();
    if (!selectedIds.length) {
      this.primarySelectedId = null;
      return -1;
    }

    if (this.primarySelectedId == null || !selectedIds.includes(parseInt(this.primarySelectedId, 10))) {
      this.primarySelectedId = selectedIds[0];
    }
    return parseInt(this.primarySelectedId, 10);
  }

  getSelectedIds() {
    const domIds = this._getSelectedIdsFromDom();
    if (domIds.length || this.selectedNodeIds.size === 0) {
      this.selectedNodeIds = new Set(domIds);
      if (this.primarySelectedId != null && !this.selectedNodeIds.has(this.primarySelectedId)) {
        this.primarySelectedId = domIds.length ? domIds[domIds.length - 1] : null;
      }
      return domIds;
    }

    return [...this.selectedNodeIds]
      .filter((id) => !Number.isNaN(id))
      .sort((a, b) => a - b);
  }

  _getSelectedIdsFromDom() {
    const selectedIds = [];
    this.svgGroup.selectAll('.node.selected').each(function(id) {
      let numericId = parseInt(id, 10);
      if (Number.isNaN(numericId)) {
        const elementId = d3.select(this).attr('id');
        if (elementId && elementId.startsWith('n')) {
          numericId = parseInt(elementId.substring(1), 10);
        }
      }
      if (!Number.isNaN(numericId)) {
        selectedIds.push(numericId);
      }
    });
    return [...new Set(selectedIds)].sort((a, b) => a - b);
  }

  clearSelection() {
    this.clearSelectionWithoutEmittingSignal();
    widget.emitEventSelectedSignal(-1);
    widget.emitSelectedNodeIdsSignal([]);
  }

  clearSelectionWithoutEmittingSignal() {
    const selectedIds = this.getSelectedIds();
    for (const cl of ['selected', 'selected-in-edge', 'selected-out-edge', 'selected-in-edge-label', 'selected-out-edge-label']) {
      d3.selectAll('.' + cl).classed(cl, false);
    }
    this.selectedNodeIds.clear();
    this.primarySelectedId = null;
    if (!graph.g) {
      return;
    }
    for (const nodeId of selectedIds) {
      this._updateNodeSelectionClass(nodeId, graph.g, false);
    }
  }

  _isTargetInsideNode(target) {
    while (target) {
      if (target.classList && target.classList.contains('node')) {
        return true;
      }
      if (target === this.svg.node()) {
        break;
      }
      target = target.parentNode;
    }
    return false;
  }

  _resolveNodeId(g, id) {
    if (!g) {
      return id;
    }
    if (g.node(id)) {
      return id;
    }
    const numericId = parseInt(id, 10);
    if (!Number.isNaN(numericId) && g.node(numericId)) {
      return numericId;
    }
    const stringId = `${id}`;
    if (g.node(stringId)) {
      return stringId;
    }
    return id;
  }

  _updateNodeSelectionClass(id, g, selected) {
    const resolvedId = this._resolveNodeId(g, id);
    const node = g.node(resolvedId);
    if (!node) {
      return;
    }
    const cleanedClass = node.class.replace(/\bselected\b/g, '').replace(/\s+/g, ' ').trim();
    node.class = selected ? `${cleanedClass} selected`.trim() : cleanedClass;
    d3.select(`#n${resolvedId}`).classed('selected', selected);
  }

  _updateEdgeHighlights(g) {
    for (const cl of ['selected-in-edge', 'selected-out-edge', 'selected-in-edge-label', 'selected-out-edge-label']) {
      d3.selectAll('.' + cl).classed(cl, false);
    }

    if (this.primarySelectedId == null) {
      return;
    }

    const id = this._resolveNodeId(g, this.primarySelectedId);
    if (!g.node(id)) {
      this.primarySelectedId = null;
      return;
    }

    g.inEdges(id).forEach((e) => {
      d3.selectAll(`.edge-${e.v}-${e.w}`).classed('selected-in-edge', true);
      d3.select(`#label-${e.name}`).classed('selected-in-edge-label', true);
    });
    g.outEdges(id).forEach((e) => {
      d3.selectAll(`.edge-${e.v}-${e.w}`).classed('selected-out-edge', true);
      d3.select(`#label-${e.name}`).classed('selected-out-edge-label', true);
    });
  }

  _refreshPrimarySelection(g) {
    const selectedIds = this.getSelectedIds()
      .filter((id) => !!g.node(this._resolveNodeId(g, id)));
    this.selectedNodeIds = new Set(selectedIds);
    if (!selectedIds.length) {
      this.primarySelectedId = null;
      this._updateEdgeHighlights(g);
      return;
    }

    if (this.primarySelectedId == null || !selectedIds.includes(parseInt(this.primarySelectedId, 10))) {
      this.primarySelectedId = selectedIds[0];
    }
    this._updateEdgeHighlights(g);
  }

  select(id, g, emitSignal=true) {
    const resolvedId = this._resolveNodeId(g, id);
    const numericId = parseInt(resolvedId, 10);
    this.clearSelectionWithoutEmittingSignal();
    this._updateNodeSelectionClass(resolvedId, g, true);
    this.selectedNodeIds.add(numericId);
    this.primarySelectedId = numericId;
    this._updateEdgeHighlights(g);
    if (emitSignal) {
      widget.emitEventSelectedSignal(numericId);
      widget.emitSelectedNodeIdsSignal(this.getSelectedIds());
    }
  }

  toggleSelection(id, g) {
    const resolvedId = this._resolveNodeId(g, id);
    const numericId = parseInt(resolvedId, 10);
    const element = this.getElement(resolvedId);
    if (!element) {
      return;
    }

    if (element.classed('selected')) {
      this._updateNodeSelectionClass(resolvedId, g, false);
      this.selectedNodeIds.delete(numericId);
      if (this.primarySelectedId === numericId) {
        this.primarySelectedId = null;
      }
    } else {
      this._updateNodeSelectionClass(resolvedId, g, true);
      this.selectedNodeIds.add(numericId);
      this.primarySelectedId = numericId;
    }

    this.selectedNodeIds = new Set(this._getSelectedIdsFromDom());
    this._refreshPrimarySelection(g);
    widget.emitEventSelectedSignal(this.getSelection());
    widget.emitSelectedNodeIdsSignal(this.getSelectedIds());
  }

  selectForContextMenu(id, g) {
    const resolvedId = this._resolveNodeId(g, id);
    const element = this.getElement(resolvedId);
    const numericId = parseInt(resolvedId, 10);
    const isSelected = !!element && (element.classed('selected') || this.selectedNodeIds.has(numericId));
    if (!isSelected) {
      this.select(id, g);
      return;
    }
    this.selectedNodeIds = new Set(this.getSelectedIds());
    this.selectedNodeIds.add(numericId);
    this.primarySelectedId = numericId;
    this._updateEdgeHighlights(g);
    widget.emitEventSelectedSignal(numericId);
    widget.emitSelectedNodeIdsSignal(this.getSelectedIds());
  }

  selectMany(ids, g) {
    this.clearSelectionWithoutEmittingSignal();
    for (const id of ids) {
      this._updateNodeSelectionClass(id, g, true);
      this.selectedNodeIds.add(parseInt(id, 10));
    }
    this.primarySelectedId = ids.length ? parseInt(ids[0], 10) : null;
    this._refreshPrimarySelection(g);
    widget.emitEventSelectedSignal(this.getSelection());
    widget.emitSelectedNodeIdsSignal(this.getSelectedIds());
  }

  getElement(id) {
    const element = d3.select(`#n${id}`);
    return element.empty() ? null : element;
  }

  getViewport() {
    return {
      translate: this.zoom.translate().slice(),
      scale: this.zoom.scale(),
    };
  }

  restoreViewport(viewport) {
    if (!viewport) {
      return;
    }
    this.zoom.scale(viewport.scale);
    this.zoom.translate(viewport.translate.slice());
    this.updateTransform();
  }

  isElementVisible(id, margin=40) {
    const element = this.getElement(id);
    if (!element) {
      return false;
    }
    const rect = element.node().getBoundingClientRect();
    return rect.right >= margin
      && rect.bottom >= margin
      && rect.left <= (window.innerWidth - margin)
      && rect.top <= (window.innerHeight - margin);
  }

  scrollTo(id, center=false, duration=1000, targetScale=null) {
    const element = this.getElement(id);
    if (!element) {
      return false;
    }
    const scale = targetScale == null ? this.zoom.scale() : targetScale;
    this.svg.interrupt();
    if (targetScale != null) {
      this.zoom.scale(scale);
    }

    const svgNode = this.svg.node();
    const elementNode = element.node();
    if (!svgNode || !elementNode) {
      return false;
    }

    const nodeTransform = d3.transform(element.attr('transform'));
    const [nodeX, nodeY] = nodeTransform.translate;
    const bbox = elementNode.getBBox();
    const graphCenterX = nodeX + bbox.x + (bbox.width / 2);
    const graphCenterY = nodeY + bbox.y + (bbox.height / 2);
    const targetX = svgNode.clientWidth / 2;
    const targetY = center ? (svgNode.clientHeight / 2) : 60;
    const nextTranslate = [
      targetX - (graphCenterX * scale),
      targetY - (graphCenterY * scale),
    ];

    this.svg.transition().duration(duration)
      .call(this.zoom.translate(nextTranslate).event);
    return true;
  }

  render(g, transitionMs=GRAPH_TRANSITION_MS) {
    const visibleGraph = new graphlib.Graph({ multigraph: true });
    visibleGraph.setGraph({});
    visibleGraph.graph().transition = (selection) => {
      if (!transitionMs) {
        return selection;
      }
      return selection.transition().duration(transitionMs);
    };

    for (const v of g.nodes()) {
      if (!this.nodeWhitelist || this.nodeWhitelist.has(v)) {
        visibleGraph.setNode(v, g.node(v));
      }
    }
    for (const e of g.edges()) {
      if (!this.nodeWhitelist || this.nodeWhitelist.has(e.v)) {
        visibleGraph.setEdge(e, g.edge(e));
      }
    }

    const render = dagreD3.render();
    this.svgGroup.selectAll('*').interrupt();
    this.svgGroup.selectAll('*').remove();
    this.svgGroup.call(render, visibleGraph);
    this._styleMessageTags();
    this.svgGroup.selectAll('.node')
      .on('click', (id) => {
        if (isMultiSelectEvent(d3.event)) {
          this.toggleSelection(id, g);
        } else {
          this.select(id, g);
        }
        d3.event.stopPropagation();
      })
      .on('dblclick', (id) => {
        if (actionsProhibited) {
          d3.event.stopPropagation();
          return;
        }

        const node = g.node(id);
        const classes = node.class.split(' ');
        if (classes.includes('entry')) {
          widget.renameEntryPoint(parseInt(id, 10));
        } else if (classes.includes('fork')) {
          widget.editForkBranches(parseInt(id, 10));
        } else {
          widget.editEvent(parseInt(id, 10));
        }
        d3.event.stopPropagation();
      })
      .on('contextmenu', (id) => {
        this.selectForContextMenu(id, g);
        d3.contextMenu(handleNodeContextMenu).call(this, id);
        clampContextMenuToViewport();
        d3.event.stopPropagation();
      });
    for (const id of this.getSelectedIds()) {
      this._updateNodeSelectionClass(id, g, true);
    }
    this._refreshPrimarySelection(g);
  }

  setScale(scale) { this.zoom.scale(scale); this.updateTransform(); }
  setTranslate(translate) { this.zoom.translate(translate); this.updateTransform(); }

  updateTransform() {
    this.svgGroup.attr('transform', `translate(${this.zoom.translate()})scale(${this.zoom.scale()})`);
  }
}

class Graph {
  constructor() {
    this.g = null;
    this.data = null;
    this.renderer = new Renderer();
    this.persistentComponentRootName = null;
  }

  update(data) {
    this.data = data;
    this.g = new graphlib.Graph({ multigraph: true });
    this.g.setGraph({});

    for (const entry of data) {
      if (entry.type === 'node') {
        this.g.setNode(entry.id, {
          label: getNodeLabel(entry),
          'class': entry.node_type,
          id: `n${entry.id}`,
          idx: entry.id,
          name: entry.data.name,
        });
      } else if (entry.type === 'edge') {
        this.g.setEdge(entry.source, entry.target, {
          labelType: 'html',
          label: `<span id="label-edge-${entry.source}-${entry.target}-${entry.data.value}">${entry.data.value == null ? '' : entry.data.value}</span>`,
          'class': `edge-${entry.source}-${entry.target}`,
          virtual: !!entry.data.virtual,
        }, `edge-${entry.source}-${entry.target}-${entry.data.value}`);
      }
    }
  }

  refresh() {
    if (this.data && Object.keys(this.data).length > 0) {
      this.update(this.data);
    }
  }

  render(transitionMs=GRAPH_TRANSITION_MS) {
    if (this.hasPersistentComponentFilter()) {
      const componentIds = this.findPersistentComponentIds();
      if (componentIds) {
        this.renderer.nodeWhitelist = componentIds;
      } else {
        this.clearPersistentComponentFilter();
        this.renderer.nodeWhitelist = null;
      }
    } else {
      this.renderer.nodeWhitelist = null;
    }

    this.renderer.render(this.g, transitionMs);
    refreshGraphSearch(false);
  }

  hasPersistentComponentFilter() {
    return !!this.persistentComponentRootName;
  }

  clearPersistentComponentFilter() {
    this.persistentComponentRootName = null;
  }

  _findNodeIdByName(name) {
    if (!this.g || name == null) {
      return null;
    }
    for (const nodeId of this.g.nodes()) {
      const node = this.g.node(nodeId);
      if (node && node.name === name) {
        return nodeId;
      }
    }
    return null;
  }

  findNodeComponentIds(v) {
    if (!this.g || v == null) {
      return null;
    }
    const resolvedId = `${v}`;
    const components = graphlib.alg.components(this.g);
    const component = components.find((entry) => entry.includes(resolvedId));
    return component ? new Set(component) : null;
  }

  findPersistentComponentIds() {
    const rootId = this._findNodeIdByName(this.persistentComponentRootName);
    if (rootId == null) {
      return null;
    }
    return this.findNodeComponentIds(rootId);
  }

  renderOnlyConnected(v) {
    const selected = this.renderer.getSelection();
    if (v == null) {
      this.clearPersistentComponentFilter();
    } else {
      const node = this.g ? this.g.node(`${v}`) : null;
      this.persistentComponentRootName = node ? node.name : null;
    }
    this.render();
    if (v != null && this.renderer.getElement(v)) {
      setTimeout(() => this.renderer.scrollTo(v), 500);
    } else if (selected !== -1 && this.renderer.getElement(selected)) {
      setTimeout(() => this.renderer.scrollTo(selected), 500);
    }
  }

  selectConnected(v) {
    const component = this.findNodeComponentIds(v);
    if (!component) {
      return;
    }
    const ids = [...component]
      .map((nodeId) => parseInt(nodeId, 10))
      .filter((nodeId) => !Number.isNaN(nodeId) && nodeId >= 0);
    this.renderer.selectMany(ids, this.g);
  }

}

graph = new Graph();

function getSearchableNodeText(node) {
  if (!node || !node.data) {
    return '';
  }

  const parts = [];
  if (node.data.actor) {
    parts.push(node.data.actor);
  }
  if (node.data.action) {
    parts.push(node.data.action);
  }
  if (node.data.query) {
    parts.push(node.data.query);
  }
  if (node.data.params) {
    try {
      parts.push(JSON.stringify(node.data.params));
    } catch (err) {
      // Ignore non-serializable values.
    }
  }
  if (node.data._message_text) {
    parts.push(node.data._message_text);
  }
  if (node.data._choice_label_texts) {
    for (const value of Object.values(node.data._choice_label_texts)) {
      parts.push(value);
    }
  }
  if (node.data.entry_point_name) {
    parts.push(node.data.entry_point_name);
  }
  if (node.data.res_flowchart_name) {
    parts.push(node.data.res_flowchart_name);
  }
  if (node.data.name) {
    parts.push(node.data.name);
  }
  return parts.join('\n');
}

function clearSearchHighlightClasses() {
  d3.selectAll('.node.search-match').classed('search-match', false);
  d3.selectAll('.node.search-current').classed('search-current', false);
}

function applySearchHighlights() {
  clearSearchHighlightClasses();
  if (!graphSearchMatches.length || !graph || !graph.renderer) {
    return;
  }

  for (const nodeId of graphSearchMatches) {
    const element = graph.renderer.getElement(nodeId);
    if (element) {
      element.classed('search-match', true);
    }
  }

  if (graphSearchIndex >= 0 && graphSearchIndex < graphSearchMatches.length) {
    const currentElement = graph.renderer.getElement(graphSearchMatches[graphSearchIndex]);
    if (currentElement) {
      currentElement.classed('search-current', true);
    }
  }
}

function emitSearchResults() {
  if (!widget || !widget.emitSearchResultsSignal) {
    return;
  }
  widget.emitSearchResultsSignal(graphSearchMatches.length, graphSearchIndex);
}

function scrollToCurrentSearchResult(duration=500) {
  if (graphSearchIndex < 0 || graphSearchIndex >= graphSearchMatches.length) {
    return;
  }
  const targetId = graphSearchMatches[graphSearchIndex];
  if (graph && graph.g && graph.g.node(targetId)) {
    graph.renderer.select(targetId, graph.g, false);
  }
  graph.renderer.scrollTo(targetId, true, duration, 1);
}

function refreshGraphSearch(scrollToResult) {
  const previousCurrentId =
    graphSearchIndex >= 0 && graphSearchIndex < graphSearchMatches.length
      ? graphSearchMatches[graphSearchIndex]
      : null;

  if (!graphSearchQuery || !graph || !graph.data) {
    graphSearchMatches = [];
    graphSearchIndex = -1;
    applySearchHighlights();
    emitSearchResults();
    return;
  }

  const normalizedNeedle = graphSearchCaseInsensitive ? graphSearchQuery.toLowerCase() : graphSearchQuery;
  graphSearchMatches = graph.data
    .filter((entry) => entry.type === 'node')
    .filter((entry) => {
      const haystack = getSearchableNodeText(entry);
      if (!haystack) {
        return false;
      }
      const normalizedHaystack = graphSearchCaseInsensitive ? haystack.toLowerCase() : haystack;
      return normalizedHaystack.includes(normalizedNeedle);
    })
    .map((entry) => parseInt(entry.id, 10))
    .filter((entryId) => !Number.isNaN(entryId));

  if (!graphSearchMatches.length) {
    graphSearchIndex = -1;
    applySearchHighlights();
    emitSearchResults();
    return;
  }

  if (previousCurrentId != null) {
    const existingIndex = graphSearchMatches.indexOf(previousCurrentId);
    graphSearchIndex = existingIndex >= 0 ? existingIndex : 0;
  } else if (graphSearchIndex < 0 || graphSearchIndex >= graphSearchMatches.length) {
    graphSearchIndex = 0;
  }

  applySearchHighlights();
  emitSearchResults();
  if (scrollToResult) {
    scrollToCurrentSearchResult();
  }
}

window.eventEditorSetSearchQuery = function(query, caseInsensitive, scrollToResult) {
  graphSearchQuery = (query || '').trim();
  graphSearchCaseInsensitive = !!caseInsensitive;
  refreshGraphSearch(!!scrollToResult);
};

window.eventEditorStepSearch = function(delta) {
  if (!graphSearchMatches.length) {
    emitSearchResults();
    return;
  }
  const offset = delta < 0 ? -1 : 1;
  graphSearchIndex = (graphSearchIndex + offset + graphSearchMatches.length) % graphSearchMatches.length;
  applySearchHighlights();
  emitSearchResults();
  scrollToCurrentSearchResult(350);
};

window.eventEditorSetSearchIndex = function(index) {
  if (!graphSearchMatches.length) {
    emitSearchResults();
    return;
  }
  const clampedIndex = Math.max(0, Math.min(graphSearchMatches.length - 1, parseInt(index, 10) || 0));
  graphSearchIndex = clampedIndex;
  applySearchHighlights();
  emitSearchResults();
  scrollToCurrentSearchResult(350);
};

document.body.addEventListener('keydown', (event) => {
  const key = event.key; // "ArrowRight", "ArrowLeft", "ArrowUp", or "ArrowDown"

  if (key === 'Escape') {
    graph.renderer.clearSelection();
    return;
  }

  // Handle zoom
  if (event.ctrlKey) {
    let scaleMultiplier = 1;
    if (key === 'ArrowUp')
      scaleMultiplier = 1.1;
    else if (key === 'ArrowDown')
      scaleMultiplier = 0.9;
    graph.renderer.setScale(graph.renderer.zoom.scale() * scaleMultiplier);
    if (scaleMultiplier !== 1)
      return;
  }

  // Handle translate / navigation
  const selected = graph.renderer.getSelection();
  if (selected === -1) {
    let vDirection = 0;
    let hDirection = 0;
    switch (key) {
      case 'ArrowUp':
        vDirection = 1;
        break;
      case 'ArrowDown':
        vDirection = -1;
        break;
      case 'ArrowLeft':
        hDirection = 1;
        break;
      case 'ArrowRight':
        hDirection = -1;
        break;
    }
    const [x, y] = graph.renderer.zoom.translate();
    graph.renderer.setTranslate([x + 100 * hDirection, y + 100 * vDirection]);
    return;
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const nodes = key === 'ArrowUp' ? graph.g.predecessors(selected) : graph.g.successors(selected);
    if (nodes.length > 0) {
      graph.renderer.scrollTo(nodes[0], true, 500);
      graph.renderer.select(nodes[0], graph.g);
    }
  }
});

new QWebChannel(qt.webChannelTransport, (channel) => {
  widget = channel.objects.widget;

  function select(id) {
    if (graph.hasPersistentComponentFilter()) {
      graph.renderOnlyConnected(id);
      graph.renderer.select(id, graph.g);
    } else {
      graph.renderer.select(id, graph.g);
      graph.renderer.scrollTo(id);
    }
  }

  function reveal(id) {
    if (graph.hasPersistentComponentFilter() && !graph.renderer.getElement(id)) {
      graph.clearPersistentComponentFilter();
      graph.render();
    }
    graph.renderer.select(id, graph.g);
    graph.renderer.scrollTo(id, true, 500);
  }

  function load(cb) {
    const loadToken = ++pendingLoadFinalizeToken;
    widget.getJson((data) => {
      if (!data) {
        return;
      }
      const transitionMs = nextGraphTransitionMs;
      nextGraphTransitionMs = GRAPH_TRANSITION_MS;
      graph.update(data);
      graph.render(transitionMs);
      const finalizeLoad = () => {
        if (loadToken !== pendingLoadFinalizeToken) {
          return;
        }
        if (preservedViewport && !resetViewportOnNextLoad) {
          graph.renderer.restoreViewport(preservedViewport);
          if (preservedFocusNodeId != null) {
            const focusedElement = graph.renderer.getElement(preservedFocusNodeId);
            const currentCenter = getElementCenterInViewport(focusedElement);
            if (currentCenter && preservedFocusPoint) {
              const nextTranslate = graph.renderer.zoom.translate().slice();
              nextTranslate[0] += preservedFocusPoint.x - currentCenter.x;
              nextTranslate[1] += preservedFocusPoint.y - currentCenter.y;
              graph.renderer.zoom.translate(nextTranslate);
              graph.renderer.updateTransform();
            }
          }
        }
        if (resetViewportOnNextLoad) {
          graph.renderer.setTranslate([20, 20]);
          resetViewportOnNextLoad = false;
        }
        widget.emitReloadedSignal();
        if (cb) {
          cb(data);
        }
        isDeleting = false;
        suppressNextViewportAdjustment = false;
        preservedViewport = null;
        preservedFocusNodeId = null;
        preservedFocusPoint = null;
      };

      setTimeout(finalizeLoad, transitionMs + 20);
    });
  }

  widget.flowDataChanged.connect(() => {
    load();
  });

  widget.fileLoaded.connect(() => {
    graph.clearPersistentComponentFilter();
    graph.renderer.clearSelection();
    preservedViewport = null;
    resetViewportOnNextLoad = true;
  });

  widget.selectRequested.connect((id) => {
    select(id);
  });

  widget.revealRequested.connect((id) => {
    reveal(id);
  });

  widget.instantRevealRequested.connect((id) => {
    if (graph.hasPersistentComponentFilter() && !graph.renderer.getElement(id)) {
      graph.clearPersistentComponentFilter();
      graph.render(0);
    }
    graph.renderer.select(id, graph.g);
    graph.renderer.scrollTo(id, true, 0);
  });

  widget.preserveViewportRequested.connect(() => {
    preservedViewport = graph.renderer.getViewport();
    preservedFocusNodeId = graph.renderer.getSelection();
    preservedFocusPoint = getElementCenterInViewport(
      preservedFocusNodeId != null && preservedFocusNodeId !== -1
        ? graph.renderer.getElement(preservedFocusNodeId)
        : null
    );
    suppressNextViewportAdjustment = true;
  });

  widget.fastGraphReloadRequested.connect(() => {
    nextGraphTransitionMs = 0;
  });

  widget.eventNameVisibilityChanged.connect((visible) => {
    eventNamesVisible = visible;
  });

  widget.eventParamVisibilityChanged.connect((visible) => {
    eventParamVisible = visible;
  });

  widget.eventMessageVisibilityChanged.connect((visible) => {
    eventMessagesVisible = visible;
  });

  widget.actionProhibitionChanged.connect((value) => {
    actionsProhibited = value;
  });

  widget.entryPointFilterStateChanged.connect((value) => {
    hasHiddenEntryPoints = !!value;
  });

  widget.emitReadySignal();
  load();
});
