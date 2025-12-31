import type { GamePlugin } from "./interface.js";
import { bridgePlugin } from "./impl/bridge.js";
import { kasinoPlugin } from "./impl/kasino.js";
import { scopaPlugin } from "./impl/scopa.js";
import { ginPlugin } from "./impl/gin-rummy.js";
import { marjapussiPlugin } from "./impl/marjapussi.js";
import { ristiseiskaPlugin } from "./impl/ristiseiska.js";
import { canastaPlugin } from "./impl/canasta.js";
import { pinnacolaPlugin } from "./impl/pinnacola.js";
import { briscolaPlugin } from "./impl/briscola.js";
import { katkoPlugin } from "./impl/katko.js";
import { durakPlugin } from "./impl/durak.js";

export const GAME_PLUGINS: Record<string, GamePlugin> = {
  [bridgePlugin.id]: bridgePlugin,
  [kasinoPlugin.id]: kasinoPlugin,
  [scopaPlugin.id]: scopaPlugin,
  [ginPlugin.id]: ginPlugin,
  [marjapussiPlugin.id]: marjapussiPlugin,
  [ristiseiskaPlugin.id]: ristiseiskaPlugin,
  [canastaPlugin.id]: canastaPlugin,
  [pinnacolaPlugin.id]: pinnacolaPlugin,
  [briscolaPlugin.id]: briscolaPlugin,
  [katkoPlugin.id]: katkoPlugin,
  [durakPlugin.id]: durakPlugin,
};

/** Convenience: list of plugins for lobbies or /games endpoint. */
export const ALL_GAME_PLUGINS: GamePlugin[] = Object.values(GAME_PLUGINS);
