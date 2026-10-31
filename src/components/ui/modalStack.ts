/**
 * Open modals, oldest first. Only the topmost answers Escape: the changelog over
 * the setup dialog closes alone; a non-dismissable one on top swallows it.
 */
export interface ModalStack {
  push(id: symbol): void;
  remove(id: symbol): void;
  isTop(id: symbol): boolean;
}

export function createModalStack(): ModalStack {
  const open: symbol[] = [];
  return {
    push(id) {
      open.push(id);
    },
    remove(id) {
      const i = open.lastIndexOf(id);
      if (i !== -1) open.splice(i, 1);
    },
    isTop(id) {
      return open.length > 0 && open[open.length - 1] === id;
    },
  };
}

/** The one stack every `Modal` in a window registers with. */
export const modalStack = createModalStack();
