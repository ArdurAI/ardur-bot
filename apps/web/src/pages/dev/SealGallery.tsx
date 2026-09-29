import { SEAL_PHASES, SEAL_SCENE_PACKS } from "@ardurbot/core";
import { botColors } from "@ardurbot/ui-tokens";
import { BotAvatar, SealScenePackProvider } from "@ardurbot/ui-web";

const SIZES = [112, 40, 24] as const;
const MOTIONS = ["moving", "still"] as const;
const THEMES = ["light", "dark"] as const;

/**
 * Development only: every seal scene pack in every phase, at 112, 40 and 24 px,
 * moving and still, on both themes. The seal gallery e2e captures it for review.
 */
export default function SealGallery() {
  return (
    <main data-testid="seal-gallery" className="min-h-full">
      {THEMES.map((theme) => (
        <section
          key={theme}
          data-testid={`seal-gallery-${theme}`}
          data-theme={theme}
          className="flex flex-col gap-10 bg-background px-10 py-8 text-foreground"
        >
          {Object.values(SEAL_SCENE_PACKS).map((pack) => (
            <SealScenePackProvider key={pack.id} value={pack.id}>
              <div data-seal-pack={pack.id} className="flex flex-col gap-3">
                <h2 className="font-serif text-3xl">{pack.name}</h2>
                <div
                  className="grid items-center gap-x-4 gap-y-3"
                  style={{ gridTemplateColumns: `7rem repeat(${SEAL_PHASES.length}, 7.5rem)` }}
                >
                  <span />
                  {SEAL_PHASES.map((phase) => (
                    <span
                      key={phase}
                      className="text-center font-mono text-xs text-muted-foreground"
                    >
                      {phase}
                    </span>
                  ))}
                  {MOTIONS.flatMap((motion) =>
                    SIZES.map((size) => (
                      <div key={`${motion}-${size}`} data-seal-motion={motion} className="contents">
                        <span className="font-mono text-xs text-muted-foreground">
                          {size} px · {motion}
                        </span>
                        {SEAL_PHASES.map((phase) => (
                          <div key={phase} className="grid place-items-center">
                            <BotAvatar
                              color={botColors[0]}
                              identity="seal-gallery"
                              label="Chief of Staff"
                              phase={phase}
                              size={size}
                              still={motion === "still"}
                            />
                          </div>
                        ))}
                      </div>
                    )),
                  )}
                  <span className="font-mono text-xs text-muted-foreground">pigments</span>
                  {botColors.map((color, index) => (
                    <div key={color} className="grid place-items-center">
                      <BotAvatar
                        color={color}
                        identity={`seal-gallery-${index}`}
                        label="Seal"
                        phase={SEAL_PHASES[1 + (index % (SEAL_PHASES.length - 1))]!}
                        size={40}
                        still
                      />
                    </div>
                  ))}
                </div>
              </div>
            </SealScenePackProvider>
          ))}
        </section>
      ))}
    </main>
  );
}
