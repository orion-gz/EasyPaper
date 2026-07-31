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
      // 노드 클릭 시 직접 연결된 이웃만 부각하고 나머지는 흐리게 처리한다.
      { selector: '.kg-dimmed', style: { opacity: 0.2 } },
      { selector: 'node.kg-selected', style: { 'border-width': 3, 'border-color': '#2563eb' } },
    ],
    layout: { name: 'fcose', quality: 'proof', animate: true },
  })
  cy.on('tap', 'node', evt => {
    const node = evt.target
    const neighborhood = node.closedNeighborhood()
    cy.elements().addClass('kg-dimmed')
    neighborhood.removeClass('kg-dimmed')
    cy.nodes().removeClass('kg-selected')
    node.addClass('kg-selected')
    onNodeClick && onNodeClick(node.data())
  })
  // 빈 캔버스(배경)를 탭하면 하이라이트를 초기화한다.
  cy.on('tap', evt => {
    if (evt.target === cy) {
      cy.elements().removeClass('kg-dimmed kg-selected')
    }
  })
  return cy
}
