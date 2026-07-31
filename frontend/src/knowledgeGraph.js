import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
cytoscape.use(fcose)

export function renderKnowledgeGraph(container, graphData, { onNodeClick } = {}) {
  const cy = cytoscape({
    container,
    elements: [
      ...graphData.nodes.map(n => ({ data: n })),
      ...graphData.edges.map(e => ({ data: e })),
    ],
    style: [
      { selector: 'node[type="paper"]', style: { shape: 'ellipse', 'background-color': '#4f8ef7', label: 'data(label)' } },
      { selector: 'node[type="concept"]', style: { shape: 'diamond', 'background-color': '#f7b34f', width: 24, height: 24, label: 'data(label)' } },
      { selector: 'edge[type="citation"]', style: { 'line-style': 'solid', 'target-arrow-shape': 'triangle', width: 1.5 } },
      { selector: 'edge[type="category"]', style: { 'line-style': 'dashed', width: 1, 'line-color': '#ccc' } },
      { selector: 'edge[type="has_concept"]', style: { 'line-style': 'dotted', width: 1 } },
    ],
    layout: { name: 'fcose', quality: 'proof', animate: true },
  })
  cy.on('tap', 'node', evt => onNodeClick && onNodeClick(evt.target.data()))
  return cy
}
