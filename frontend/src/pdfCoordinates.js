/** Convert viewport CSS pixels to the unscaled padding box used by PDF overlays.
 * DPR belongs to the canvas backing store, never to DOM geometry.
 */
export function pageCoordinates(element) {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const px = name => Number.parseFloat(style[name]) || 0
  const borderX = px('borderLeftWidth') + px('borderRightWidth')
  const borderY = px('borderTopWidth') + px('borderBottomWidth')
  const width = px('width') + (style.boxSizing === 'border-box' ? 0 : px('paddingLeft') + px('paddingRight') + borderX)
  const height = px('height') + (style.boxSizing === 'border-box' ? 0 : px('paddingTop') + px('paddingBottom') + borderY)
  const scaleX = width > 0 && rect.width > 0 ? rect.width / width : 1
  const scaleY = height > 0 && rect.height > 0 ? rect.height / height : 1
  return {
    width: width - borderX,
    height: height - borderY,
    rectToLocal: source => ({
      left: (source.left - rect.left) / scaleX - px('borderLeftWidth') + element.scrollLeft,
      top: (source.top - rect.top) / scaleY - px('borderTopWidth') + element.scrollTop,
      width: source.width / scaleX,
      height: source.height / scaleY,
    }),
  }
}
