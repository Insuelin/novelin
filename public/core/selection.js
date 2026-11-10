export function selectionTouches(editorState, from, to) {
  return editorState.selection.ranges.some((range) => {
    if (range.empty) return range.head >= from && range.head <= to;
    return range.from <= to && range.to >= from;
  });
}
