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
      { selector: 'node[type="note"]', style: { shape: 'round-rectangle', 'background-color': '#8b5cf6', width: 16, height: 16, label: 'data(label)', 'font-size': 8 } },
      { selector: 'edge[type="citation"]', style: { 'line-style': 'solid', 'target-arrow-shape': 'triangle', width: 1.5 } },
      { selector: 'edge[type="category"]', style: { 'line-style': 'dashed', width: 1, 'line-color': '#ccc' } },
      { selector: 'edge[type="has_concept"]', style: { 'line-style': 'dotted', width: 1 } },
      { selector: 'edge[type="notes_on"]', style: { 'line-style': 'dotted', width: 1, 'line-color': '#8b5cf6' } },
      { selector: 'edge[type="similar_to"]', style: { 'line-style': 'dashed', width: 1.5, 'line-color': '#f7b34f', 'curve-style': 'bezier' } },
      // 노드 클릭 시 직접 연결된 이웃만 부각하고 나머지는 흐리게 처리한다.
      { selector: '.kg-dimmed', style: { opacity: 0.2 } },
      { selector: 'node.kg-selected', style: { 'border-width': 3, 'border-color': '#2563eb' } },
      // Node Search로 매칭된 노드를 강조한다.
      { selector: 'node.kg-search-match', style: { 'border-width': 3, 'border-color': '#16a34a' } },
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

// Node Search 결과로 매칭된 노드만 강조하고(kg-search-match) 나머지는 흐리게
// 처리한 뒤, 매칭된 노드가 모두 보이도록 화면을 맞춘다. nodeIds가 비어 있으면
// (검색어를 지웠을 때) 하이라이트를 전부 초기화한다.
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
