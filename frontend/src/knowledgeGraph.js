import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
cytoscape.use(fcose)

export function renderKnowledgeGraph(container, graphData, { onNodeClick } = {}) {
  // 테마(다크/라이트)에 맞는 색상을 CSS 변수에서 읽어온다. cytoscape는 캔버스에
  // 직접 그리므로 style 객체에 var(...)를 그대로 넣을 수 없어 계산된 값을 사용한다.
  const rootStyle = getComputedStyle(document.documentElement)
  const hoverBg = rootStyle.getPropertyValue('--bg-panel').trim() || '#fff'
  const hoverBorder = rootStyle.getPropertyValue('--border-strong').trim() || '#d1d5db'
  const hoverText = rootStyle.getPropertyValue('--text-primary').trim() || '#111'

  const cy = cytoscape({
    container,
    elements: [
      ...graphData.nodes.map(n => ({ data: n })),
      ...graphData.edges.map(e => ({ data: e })),
    ],
    style: [
      // 기본적으로는 라벨을 그리지 않는다 — 논문 제목처럼 긴 텍스트가 항상 떠 있으면
      // 그래프 가독성이 떨어지므로, 노드에 마우스를 올렸을 때만(.kg-hover) 표시한다.
      { selector: 'node', style: { label: '' } },
      { selector: 'node[type="paper"]', style: { shape: 'ellipse', 'background-color': '#4f8ef7' } },
      { selector: 'node[type="concept"]', style: { shape: 'diamond', 'background-color': '#f7b34f', width: 24, height: 24 } },
      { selector: 'node[type="note"]', style: { shape: 'round-rectangle', 'background-color': '#8b5cf6', width: 16, height: 16 } },
      { selector: 'node[type="figure"]', style: { shape: 'triangle', 'background-color': '#10b981', width: 16, height: 16 } },
      { selector: 'edge[type="citation"]', style: { 'line-style': 'solid', 'target-arrow-shape': 'triangle', width: 1.5 } },
      { selector: 'edge[type="category"]', style: { 'line-style': 'dashed', width: 1, 'line-color': '#ccc' } },
      { selector: 'edge[type="has_concept"]', style: { 'line-style': 'dotted', width: 1 } },
      { selector: 'edge[type="notes_on"]', style: { 'line-style': 'dotted', width: 1, 'line-color': '#8b5cf6' } },
      { selector: 'edge[type="shows_figure"]', style: { 'line-style': 'dotted', width: 1, 'line-color': '#10b981' } },
      { selector: 'edge[type="similar_to"]', style: { 'line-style': 'dashed', width: 1.5, 'line-color': '#f7b34f', 'curve-style': 'bezier' } },
      // 노드 클릭 시 직접 연결된 이웃만 부각하고 나머지는 흐리게 처리한다.
      { selector: '.kg-dimmed', style: { opacity: 0.2 } },
      { selector: 'node.kg-selected', style: { 'border-width': 3, 'border-color': '#2563eb' } },
      // Node Search로 매칭된 노드를 강조한다.
      { selector: 'node.kg-search-match', style: { 'border-width': 3, 'border-color': '#16a34a' } },
      // 노드에 마우스를 올렸을 때만 라벨(논문 제목 등)을 표시한다.
      {
        selector: 'node.kg-hover',
        style: {
          label: 'data(label)',
          'font-size': 11,
          color: hoverText,
          'text-wrap': 'wrap',
          'text-max-width': '140px',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -6,
          'text-background-color': hoverBg,
          'text-background-opacity': 0.95,
          'text-background-padding': '3px',
          'text-border-width': 1,
          'text-border-color': hoverBorder,
          'text-border-opacity': 1,
          'z-index': 999,
        },
      },
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
    // 상세 패널에서 "관련 논문"/"유사 개념" 같은 1촌 이웃 목록을 다시 조회하지
    // 않고 바로 보여줄 수 있도록, 이미 계산해둔 이웃 노드 데이터를 함께 넘긴다.
    const neighborNodes = neighborhood.nodes().filter(n => n.id() !== node.id()).map(n => n.data())
    onNodeClick && onNodeClick(node.data(), neighborNodes)
  })
  // 빈 캔버스(배경)를 탭하면 하이라이트를 초기화한다.
  cy.on('tap', evt => {
    if (evt.target === cy) {
      cy.elements().removeClass('kg-dimmed kg-selected')
    }
  })
  // 노드에 마우스를 올리면 라벨을 표시하고, 벗어나면 다시 숨긴다.
  cy.on('mouseover', 'node', evt => {
    evt.target.addClass('kg-hover')
  })
  cy.on('mouseout', 'node', evt => {
    evt.target.removeClass('kg-hover')
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
