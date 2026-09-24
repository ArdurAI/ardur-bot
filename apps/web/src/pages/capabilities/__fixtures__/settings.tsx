import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { I18nBootstrap } from "../../../components/I18nBootstrap";
import { SettingsOverlay } from "../../SettingsOverlay";
import "../../../styles.css";

if (import.meta.env.DEV) {
  createRoot(document.getElementById("root")!).render(
    <I18nBootstrap>
      <BrowserRouter>
        <SettingsOverlay
          name="Fixture"
          avatarStyle="robot"
          initialSection="capabilities"
          isDeploymentOwner
          memoryConfig={null}
          onMemoryConfigChange={() => {}}
          onAvatarStyleChange={async () => {}}
          onClose={() => {}}
        />
      </BrowserRouter>
    </I18nBootstrap>,
  );
}
