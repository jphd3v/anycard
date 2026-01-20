export type CardSetId =
  | "RevK"
  | "RevK_mobile"
  | "notpeter"
  | "digitaldesignlabs_sm"
  | "digitaldesignlabs_xl"
  | "htdebeer"
  | "brescia"
  | "atlasnye";

export type CardSetDefinition = {
  id: CardSetId;
  label: string;
  path?: string;
  supportsJokers: boolean;
};

export const CARD_SETS: CardSetDefinition[] = [
  {
    id: "digitaldesignlabs_xl",
    label: "digitaldesignlabs (XL)",
    path: "digitaldesignlabs/xl",
    supportsJokers: true,
  },
  { id: "RevK_mobile", label: "RevK (Mobile)", supportsJokers: true },
  { id: "RevK", label: "RevK", supportsJokers: true },
  {
    id: "digitaldesignlabs_sm",
    label: "digitaldesignlabs (SM)",
    path: "digitaldesignlabs/sm",
    supportsJokers: true,
  },
  { id: "notpeter", label: "notpeter", supportsJokers: true },
  { id: "htdebeer", label: "htdebeer", supportsJokers: true },
  { id: "atlasnye", label: "atlasnye", supportsJokers: true },
  { id: "brescia", label: "brescia", supportsJokers: true },
];

export const DEFAULT_CARD_SET: CardSetId = "digitaldesignlabs_xl";
export const DEFAULT_MOBILE_CARD_SET: CardSetId = "RevK_mobile";
export const DEFAULT_CARD_BACK = "1B";

export const findCardSetById = (
  id: string | null | undefined
): CardSetDefinition | undefined => CARD_SETS.find((set) => set.id === id);
