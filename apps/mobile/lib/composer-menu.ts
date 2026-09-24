export const COMPOSER_MENU_OPTIONS = ["Files", "Photos", "Slash commands", "Connectors"] as const;
export type ComposerMenuOption = (typeof COMPOSER_MENU_OPTIONS)[number];
