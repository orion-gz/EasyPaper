import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
cytoscape.use(fcose)

export function renderKnowledgeGraph(container, graphData, { onNodeClick } = {}) {
  const rootStyle = getComputedStyle(document.documentElement)
  const hoverBg = rootStyle.getPropertyValue('--bg-panel').trim() || '#fff'
  const hoverBorder = rootStyle.getPropertyValue('--border-strong').trim() || '#d1d5db'
  const hoverText = rootStyle.getPropertyValue('--text-primary').trim() || '#111'
  const accentColor = rootStyle.getPropertyValue('--control-accent').trim() || '#3987e5'
  const successColor = rootStyle.getPropertyValue('--success').trim() || '#199e70'
  const warningColor = rootStyle.getPropertyValue('--warning').trim() || '#d97706'
  const edgeMuted = rootStyle.getPropertyValue('--border-strong').trim() || '#9ca3af'

  const cy = cytoscape({
    container,
    elements: [
      ...graphData.nodes.map(n => ({ data: n })),
      ...graphData.edges.map(e => ({ data: e })),
    ],
    style: [
      { selector: 'node', style: { label: '' } },
      { selector: 'node[type="paper"]', style: { shape: 'ellipse', 'background-color': accentColor, width: 22, height: 22 } },
      { selector: 'node[type="concept"]', style: { shape: 'diamond', 'background-color': warningColor, width: 22, height: 22 } },
      { selector: 'node[type="note"]', style: { shape: 'round-rectangle', 'background-color': '#5b7aa6', width: 15, height: 15 } },
      { selector: 'node[type="figure"]', style: { shape: 'triangle', 'background-color': successColor, width: 16, height: 16 } },
      { selector: 'node[type="tag"]', style: { shape: 'round-rectangle', 'background-color': '#b86b52', width: 19, height: 13 } },
      { selector: 'edge[type="citation"]', style: { 'line-style': 'solid', 'target-arrow-shape': 'triangle', width: 1.25, 'line-color': edgeMuted, 'target-arrow-color': edgeMuted } },
      { selector: 'edge[type="category"]', style: { 'line-style': 'dashed', width: 'mapData(weight, 1, 4, 1, 2.4)', 'line-color': edgeMuted } },
      { selector: 'edge[type="has_concept"]', style: { 'line-style': 'dotted', width: 1, 'line-color': edgeMuted } },
      { selector: 'edge[type="notes_on"]', style: { 'line-style': 'dotted', width: 1, 'line-color': '#5b7aa6' } },
      { selector: 'edge[type="shows_figure"]', style: { 'line-style': 'dotted', width: 1, 'line-color': successColor } },
      { selector: 'edge[type="similar_to"]', style: { 'line-style': 'dashed', width: 1.3, 'line-color': warningColor, 'curve-style': 'bezier' } },
      { selector: 'edge[type="tagged_with"]', style: { 'line-style': 'dotted', width: 1, 'line-color': '#b86b52' } },
      { selector: '.kg-dimmed', style: { opacity: 0.18 } },
      { selector: 'node.kg-selected', style: { 'border-width': 2.5, 'border-color': hoverText } },
      { selector: 'node.kg-search-match', style: { 'border-width': 2.5, 'border-color': successColor } },
      {
        selector: 'node.kg-hover',
        style: {
          label: 'data(label)',
          'font-size': 11,
          color: hoverText,
          'text-wrap': 'wrap',
          'text-max-width': '148px',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -6,
          'text-background-color': hoverBg,
          'text-background-opacity': 0.96,
          'text-background-padding': '4px',
          'text-border-width': 1,
          'text-border-color': hoverBorder,
          'text-border-opacity': 1,
          'z-index': 999,
        },
      },
    ],
    layout: { name: 'fcose', quality: 'default', animate: true },
  })
  cy.on('tap', 'node', evt => {
    const node = evt.target
    const neighborhood = node.closedNeighborhood()
    cy.elements().addClass('kg-dimmed')
    neighborhood.removeClass('kg-dimmed')
    cy.nodes().removeClass('kg-selected')
    node.addClass('kg-selected')
    const neighborNodes = neighborhood.nodes().filter(n => n.id() !== node.id()).map(n => n.data())
    onNodeClick && onNodeClick(node.data(), neighborNodes)
  })
  cy.on('tap', evt => {
    if (evt.target === cy) {
      cy.elements().removeClass('kg-dimmed kg-selected')
    }
  })
  cy.on('mouseover', 'node', evt => {
    evt.target.addClass('kg-hover')
  })
  cy.on('mouseout', 'node', evt => {
    evt.target.removeClass('kg-hover')
  })
  return cy
}

export function highlightSearchMatches(cy, nodeIds) {
  cy.elements().removeClass('kg-dimmed kg-search-match')
  if (!nodeIds || nodeIds.length === 0) return

  const matched = cy.collection()
  for (const id of nodeIds) {
    const ele = cy.getElementById(id)
    if (ele && ele.length) matched.merge(ele)
  }
  if (matched.length === 0) return

  cy.elements().addClass('kg-dimmed')
  matched.removeClass('kg-dimmed').addClass('kg-search-match')
  cy.fit(matched, 60)
}
