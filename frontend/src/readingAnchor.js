// Reader pages are vertically ordered direct children. Binary search avoids
// measuring every preceding page when saving a position near a book's end.
export function findReadingAnchor(children, viewportTop) {
  let low = 0
  let high = children.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (children[middle].getBoundingClientRect().bottom > viewportTop) high = middle
    else low = middle + 1
  }
  return children[low] || null
}
