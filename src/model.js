export const TEXT_DEFAULT_COLOR = '#9e9e9e';

export function newCard(fields) {
  return {
    id: crypto.randomUUID(),
    title: '',
    color: TEXT_DEFAULT_COLOR,
    manual: { x: 0, y: 0, w: 240, h: 180 },
    hasThumb: false,
    includeVideo: false,
    updatedAt: Date.now(),
    ...fields,
  };
}

export function newBoard(name) {
  return { id: crypto.randomUUID(), name, cards: [], updatedAt: Date.now() };
}
