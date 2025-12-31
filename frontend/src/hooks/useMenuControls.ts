import { useSetAtom } from "jotai";
import {
  isMenuOpenAtom,
  isActionsOpenAtom,
  isScoreboardOpenAtom,
  aiLogVisibleAtom,
} from "../state";

export function useMenuControls() {
  const setIsMenuOpen = useSetAtom(isMenuOpenAtom);
  const setIsActionsOpen = useSetAtom(isActionsOpenAtom);
  const setIsScoreboardOpen = useSetAtom(isScoreboardOpenAtom);
  const setIsAiLogVisible = useSetAtom(aiLogVisibleAtom);

  function closeAll(delayMs: number = 0, options?: { skipActions?: boolean }) {
    const close = () => {
      setIsMenuOpen(false);
      if (!options?.skipActions) {
        setIsActionsOpen(false);
      }
      setIsScoreboardOpen(false);
      setIsAiLogVisible(false);
    };

    if (delayMs > 0) {
      setTimeout(close, delayMs);
    } else {
      close();
    }
  }

  return {
    closeAll,
    setIsMenuOpen,
    setIsActionsOpen,
    setIsScoreboardOpen,
    setIsAiLogVisible,
  };
}
