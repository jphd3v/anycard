import { useAtomValue } from "jotai";
import { availableGamesAtom } from "../state";

export function useGameTitle(rulesId: string | undefined | null) {
  const availableGames = useAtomValue(availableGamesAtom);

  if (!rulesId) return null;

  const game = availableGames.find((g) => g.id === rulesId);
  return game?.name ?? rulesId;
}
